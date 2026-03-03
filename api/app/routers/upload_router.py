# api/app/routers/upload_router.py

import os
import logging
from typing import List

import httpx
from fastapi import APIRouter, UploadFile, File, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..settings import settings
from ..deps import require_user, require_user_or_ingestion
from ..helpers import (
    detect_file_period,
    parse_iso_date,
    to_uae_iso,
    normalize_confidence,
    extract_fault_type,
    simple_feature_extract,
    iter_rows_from_bytes,
    build_message_samples,
    UAE_TZ,
)
from shared.schemas import WindowData
from .. import models, schemas

logger = logging.getLogger(__name__)
router = APIRouter()



@router.post("/v1/uploads", response_model=schemas.UploadResponse)
async def upload_file(
    file: UploadFile = File(...),
    subsystem: str = "GP",
    db: Session = Depends(get_db),
    _: models.User | None = Depends(require_user_or_ingestion),
):
    try:
        content = await file.read()
        if not content:
            raise HTTPException(status_code=400, detail="Empty file")

        safe_name = file.filename.replace("..", "").replace("/", "_").replace("\\", "_")
        file_path = os.path.join(settings.upload_dir, safe_name)
        with open(file_path, "wb") as f:
            f.write(content)

        features = simple_feature_extract(content)
        date_str, period, p_label = detect_file_period(safe_name)

        # Auto-detect subsystem based on headers
        cols = features.get("columns", 0)
        subsystem = "LLZ" if cols > 130 else "GP"

        upload_row = models.Upload(
            filename=safe_name,
            subsystem=subsystem,
            date_str=date_str,
            period=period,
            period_label=p_label,
            file_path=file_path,
            parsed_features=features,
        )
        db.add(upload_row)
        db.commit()
        db.refresh(upload_row)

        samples = build_message_samples(iter_rows_from_bytes(content))
        window_size = 300
        
        # Default fallback values
        final_prediction = "NORMAL"
        highest_confidence = 0.0
        overall_anomaly_rate = 0.0
        issues = []
        metrics = {}
        model_version = "heuristic-fallback-0.3"

        if len(samples) < window_size:
            # Not enough data for 300 row inference, just submit them all and hope for the best
            windows = [samples]
        else:
            windows = []
            for i in range(0, len(samples), window_size):
                window = samples[i:i+window_size]
                if len(window) < window_size and i > 0:
                    # Pad from the left using previous elements to guarantee exactly 300 elements
                    window_diff = window_size - len(window)
                    window = samples[i-window_diff : i+len(window)]
                windows.append(window)

        # Iteratively call ML node for each chunk
        async with httpx.AsyncClient(timeout=60.0) as client:
            fault_results = []
            normal_results = []

            for seq, win_samples in enumerate(windows):
                if not win_samples:
                    continue
                start_ts = win_samples[0].ts
                end_ts = win_samples[-1].ts

                window_data = WindowData(
                    start_ts=start_ts,
                    end_ts=end_ts,
                    samples=win_samples
                )

                payload = {
                    "subsystem": subsystem,
                    "features": features,
                    "window": window_data.dict(),
                    "metadata": {"filename": safe_name, "upload_id": upload_row.id, "chunk_seq": seq},
                }

                r = await client.post(f"{settings.ml_service_url}/v1/predict", json=payload)
                r.raise_for_status()
                ml_result = r.json()

                pred = ml_result.get("prediction", "NORMAL")
                conf = float(ml_result.get("confidence", 0.0))
                
                res_obj = {
                    "ml": ml_result,
                    "start": start_ts,
                    "end": end_ts
                }
                
                if pred == "FAULT":
                    fault_results.append(res_obj)
                    # Early stop: if we encounter an anomaly, flag the file immediately and stop checking subsequent windows.
                    break
                else:
                    normal_results.append(res_obj)

        if fault_results:
            # Pick the fault window with the highest confidence
            fault_results.sort(key=lambda x: float(x["ml"].get("confidence", 0.0)), reverse=True)
            best_fault = fault_results[0]
            ml = best_fault["ml"]
            final_prediction = "FAULT"
            highest_confidence = float(ml["confidence"])
            overall_anomaly_rate = float(ml.get("anomaly_rate", 0.0))
            model_version = ml.get("model_version", "stub-0.2")
            metrics = ml.get("metrics", {})
            
            new_issues = ml.get("issues", [])
            for issue in new_issues:
                # Append the specific timestamp boundaries to the description
                issue["description"] = f"{issue.get('description', '')} Time constraint between {best_fault['start']} and {best_fault['end']}."
            issues = new_issues

        elif normal_results:
            # All normal, return the first/lowest confidence normal one
            normal_results.sort(key=lambda x: float(x["ml"].get("confidence", 0.0)))
            best_normal = normal_results[0]
            ml = best_normal["ml"]
            final_prediction = "NORMAL"
            highest_confidence = float(ml["confidence"])
            overall_anomaly_rate = float(ml.get("anomaly_rate", 0.0))
            model_version = ml.get("model_version", "stub-0.2")
            metrics = ml.get("metrics", {})
            issues = ml.get("issues", [])

        pred_row = models.PredictionRun(
            upload_id=upload_row.id,
            model_version=model_version,
            prediction=final_prediction,
            confidence=highest_confidence,
            anomaly_rate=overall_anomaly_rate,
            issues=issues,
            metrics=metrics,
        )
        db.add(pred_row)
        db.commit()

        return {
            "upload_id": upload_row.id,
            "filename": safe_name,
            "subsystem": subsystem,
            "features": features,
            "ml": {
                "prediction": final_prediction,
                "confidence": highest_confidence,
                "anomaly_rate": overall_anomaly_rate,
                "issues": issues,
                "model_version": model_version,
                "metrics": metrics
            },
        }

    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"ML service error: {str(e)}")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Upload failed")
        raise HTTPException(status_code=500, detail=str(e))




@router.get("/v1/history", response_model=List[schemas.HistoryItem])
def get_history(
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    _: models.User = Depends(require_user),
):
    q = (
        db.query(models.PredictionRun)
        .join(models.Upload, models.PredictionRun.upload_id == models.Upload.id)
        .order_by(models.PredictionRun.created_at.desc())
        .limit(limit)
    )

    items = []
    for pr in q.all():
        u = pr.upload
        feats = u.parsed_features or {}
        lines = int(feats.get("lines", 0))
        conf_pct = normalize_confidence(float(pr.confidence))

        items.append(
            {
                "uploadId": u.id,
                "filename": u.filename,
                "subsystem": u.subsystem,
                "dateStr": u.date_str,
                "period": u.period,
                "periodLabel": u.period_label or "Unknown Period",
                "recordCount": lines,
                "prediction": pr.prediction,
                "faultType": extract_fault_type(pr.issues),
                "anomalyRate": float(pr.anomaly_rate) if pr.anomaly_rate is not None else None,
                "metrics": getattr(pr, "metrics", None),
                "modelVersion": pr.model_version,
                "confidence": f"{conf_pct:.1f}",
                "uploadedAt": to_uae_iso(u.uploaded_at),
            }
        )

    return items


@router.post("/v1/telemetry/windows", response_model=schemas.UploadResponse)
async def ingest_window(
    req: schemas.TelemetryWindowRequest,
    db: Session = Depends(get_db),
    _: models.User | None = Depends(require_user_or_ingestion),
):
    try:
        window = req.window
        if not window.samples:
            raise HTTPException(status_code=400, detail="Window has no samples")

        date_str = parse_iso_date(window.start_ts)
        filename = f"telemetry-{req.subsystem}-{window.start_ts}-{window.end_ts}.json"
        filename = filename.replace(":", "_")

        features = {
            "sample_count": len(window.samples),
            "signal_count": len(window.samples[0].signals or {}),
            "window_start_ts": window.start_ts,
            "window_end_ts": window.end_ts,
        }

        upload_row = models.Upload(
            filename=filename,
            subsystem=req.subsystem.upper(),
            date_str=date_str,
            period="window",
            period_label="5-min window",
            file_path="telemetry://window",
            parsed_features=features,
        )
        db.add(upload_row)
        db.commit()
        db.refresh(upload_row)

        payload = {
            "subsystem": req.subsystem,
            "window": window.dict(),
            "metadata": {"upload_id": upload_row.id, **(req.metadata or {})},
        }

        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(f"{settings.ml_service_url}/v1/predict", json=payload)
            r.raise_for_status()
            ml = r.json()

        pred_row = models.PredictionRun(
            upload_id=upload_row.id,
            model_version=ml.get("model_version", "stub-0.2"),
            prediction=ml["prediction"],
            confidence=float(ml["confidence"]),
            anomaly_rate=float(ml.get("anomaly_rate", 0.0)),
            issues=ml.get("issues", []),
            metrics=ml.get("metrics", {}),
        )
        db.add(pred_row)
        db.commit()

        return {
            "upload_id": upload_row.id,
            "filename": filename,
            "subsystem": req.subsystem,
            "features": features,
            "ml": ml,
        }
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"ML service error: {str(e)}")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Telemetry window ingestion failed")
        raise HTTPException(status_code=500, detail=str(e))
