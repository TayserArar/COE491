# api/app/main.py

import os
import re
from datetime import datetime, timezone
from typing import List

import httpx
from fastapi import FastAPI, UploadFile, File, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from .settings import settings
from .db import Base, engine, get_db
from . import models
from . import schemas


app = FastAPI(title="DANS API", version="0.2")


# ---------------------------
# CORS
# ---------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------
# Startup
# ---------------------------
@app.on_event("startup")
def on_startup():
    os.makedirs(settings.upload_dir, exist_ok=True)
    # Quick-start only. Later replace with Alembic migrations.
    Base.metadata.create_all(bind=engine)


# ---------------------------
# Health
# ---------------------------
@app.get("/health")
def health():
    return {"status": "ok"}


# ---------------------------
# Helpers
# ---------------------------
def detect_file_period(filename: str):
    """
    Your frontend uses: YYYY-MM-DD-a or YYYY-MM-DD-b in filename.
    a -> morning, b -> afternoon
    """
    m = re.search(r"(\d{4}-\d{2}-\d{2})-([ab])", filename, re.I)
    if m:
        date_str = m.group(1)
        is_a = m.group(2).lower() == "a"
        period = "morning" if is_a else "afternoon"
        label = "Morning (a)" if is_a else "Afternoon (b)"
        return date_str, period, label

    d = re.search(r"(\d{4}-\d{2}-\d{2})", filename)
    if d:
        return d.group(1), "unknown", "Unknown Period"

    today = datetime.now(timezone.utc).date().isoformat()
    return today, "unknown", "Unknown Period"


def normalize_confidence(conf: float) -> float:
    """
    If ML returns 0..1, convert to 0..100. If it returns already percent, keep it.
    """
    return conf * 100.0 if conf <= 1.0 else conf


def simple_feature_extract(file_bytes: bytes) -> dict:
    """
    Stub parser. Replace later with real NORMARC parsing + feature extraction.
    """
    size = len(file_bytes)
    text = file_bytes.decode("utf-8", errors="ignore")
    lines = text.count("\n") + 1 if text else 0
    warning_hits = text.lower().count("warn")
    alarm_hits = text.lower().count("alarm")

    anomaly_rate = min(1.0, (warning_hits + 2 * alarm_hits) / max(1, lines))
    return {
        "bytes": size,
        "lines": lines,
        "warning_hits": warning_hits,
        "alarm_hits": alarm_hits,
        "anomaly_rate": anomaly_rate,
    }


def upload_to_analysis(upload_row: models.Upload, pred_row: models.PredictionRun) -> dict:
    feats = upload_row.parsed_features or {}
    lines = int(feats.get("lines", 0))
    alarms = int(feats.get("alarm_hits", 0))
    warns = int(feats.get("warning_hits", 0))
    normal = max(0, lines - alarms - warns)

    total = alarms + warns + normal
    alarm_rate = (alarms / total) * 100.0 if total else 0.0
    warning_rate = (warns / total) * 100.0 if total else 0.0

    pred = pred_row.prediction
    severity = "critical" if pred == "FAULT" else ("moderate" if pred == "WARNING" else "none")
    conf_pct = normalize_confidence(float(pred_row.confidence))

    issues = pred_row.issues or []
    # Backward compat if you ever stored {"items":[...]}
    if isinstance(issues, dict) and "items" in issues:
        issues = issues["items"]

    return {
        "prediction": pred,
        "confidence": f"{conf_pct:.1f}",
        "rul": int(round(float(pred_row.rul_hours))),
        "severity": severity,
        "recordCount": lines,
        "alarmRate": f"{alarm_rate:.2f}",
        "warningRate": f"{warning_rate:.2f}",
        "statusCounts": {"alarm": alarms, "warning": warns, "normal": normal, "error": 0},
        "timeRange": {"start": "00:00", "end": "23:59"},
        "issues": issues,
    }


def combine_analyses(morning: dict, afternoon: dict) -> dict:
    total_records = morning["recordCount"] + afternoon["recordCount"]
    total_alarms = morning["statusCounts"]["alarm"] + afternoon["statusCounts"]["alarm"]
    total_warnings = morning["statusCounts"]["warning"] + afternoon["statusCounts"]["warning"]
    total_normal = morning["statusCounts"]["normal"] + afternoon["statusCounts"]["normal"]
    total_errors = morning["statusCounts"].get("error", 0) + afternoon["statusCounts"].get("error", 0)

    total_statuses = total_alarms + total_warnings + total_normal + total_errors
    alarm_rate = (total_alarms / total_statuses) * 100.0 if total_statuses else 0.0
    warning_rate = (total_warnings / total_statuses) * 100.0 if total_statuses else 0.0

    # Simple combined rules (replace with real logic later)
    if alarm_rate > 15 or warning_rate > 25:
        prediction = "FAULT"
        severity = "critical"
    elif alarm_rate > 5 or warning_rate > 10:
        prediction = "WARNING"
        severity = "moderate"
    else:
        prediction = "NORMAL"
        severity = "none"

    confidence = min(98.0, 85.0 + (100.0 - alarm_rate - warning_rate) / 10.0)
    rul = max(24, int(1000 - (alarm_rate * 30) - (warning_rate * 10)))

    return {
        "prediction": prediction,
        "confidence": f"{confidence:.1f}",
        "rul": rul,
        "severity": severity,
        "recordCount": total_records,
        "alarmRate": f"{alarm_rate:.2f}",
        "warningRate": f"{warning_rate:.2f}",
        "statusCounts": {
            "alarm": total_alarms,
            "warning": total_warnings,
            "normal": total_normal,
            "error": total_errors,
        },
        "timeRange": {"start": morning["timeRange"]["start"], "end": afternoon["timeRange"]["end"]},
        "issues": (morning.get("issues") or []) + (afternoon.get("issues") or []),
    }


# ---------------------------
# Upload + Analyze
# ---------------------------
@app.post("/v1/uploads", response_model=schemas.UploadResponse)
async def upload_file(
    file: UploadFile = File(...),
    subsystem: str = "GP",
    db: Session = Depends(get_db),
):
    try:
        content = await file.read()
        if not content:
            raise HTTPException(status_code=400, detail="Empty file")

        # Save file
        safe_name = file.filename.replace("..", "").replace("/", "_").replace("\\", "_")
        file_path = os.path.join(settings.upload_dir, safe_name)
        with open(file_path, "wb") as f:
            f.write(content)

        # Extract features (stub)
        features = simple_feature_extract(content)

        # Determine date/period from filename
        date_str, period, p_label = detect_file_period(safe_name)

        # Store upload row
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

        # Call ML service
        payload = {
            "subsystem": subsystem,
            "features": features,
            "metadata": {"filename": safe_name, "upload_id": upload_row.id},
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(f"{settings.ml_service_url}/v1/predict", json=payload)
            r.raise_for_status()
            ml = r.json()

        # Store prediction row
        pred_row = models.PredictionRun(
            upload_id=upload_row.id,
            model_version=ml.get("model_version", "stub-0.1"),
            prediction=ml["prediction"],
            confidence=float(ml["confidence"]),
            rul_hours=float(ml["rul_hours"]),
            anomaly_rate=float(ml["anomaly_rate"]),
            issues=ml.get("issues", []),
        )
        db.add(pred_row)
        db.commit()

        return {
            "upload_id": upload_row.id,
            "filename": safe_name,
            "subsystem": subsystem,
            "features": features,
            "ml": ml,
        }

    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"ML service error: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------
# Step 3 endpoints (dates/day/history)
# ---------------------------
@app.get("/v1/dates", response_model=List[str])
def get_dates_with_data(db: Session = Depends(get_db)):
    rows = (
        db.query(models.Upload.date_str)
        .filter(models.Upload.date_str.isnot(None))
        .distinct()
        .order_by(models.Upload.date_str.asc())
        .all()
    )
    return [r[0] for r in rows if r and r[0]]


@app.get("/v1/days/{date_str}", response_model=schemas.DayDataResponse)
def get_day(date_str: str, db: Session = Depends(get_db)):
    uploads = db.query(models.Upload).filter(models.Upload.date_str == date_str).all()

    out = {"morning": None, "afternoon": None, "combined": None}

    for u in uploads:
        if u.prediction is None:
            continue

        analysis = upload_to_analysis(u, u.prediction)

        if u.period == "morning":
            out["morning"] = analysis
        elif u.period == "afternoon":
            out["afternoon"] = analysis
        else:
            # unknown period: place into first available slot
            if out["morning"] is None:
                out["morning"] = analysis
            elif out["afternoon"] is None:
                out["afternoon"] = analysis

    if out["morning"] and out["afternoon"]:
        out["combined"] = combine_analyses(out["morning"], out["afternoon"])

    return out


@app.get("/v1/history", response_model=List[schemas.HistoryItem])
def get_history(
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
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
                "dateStr": u.date_str,
                "period": u.period,
                "periodLabel": u.period_label or "Unknown Period",
                "recordCount": lines,
                "prediction": pr.prediction,
                "confidence": f"{conf_pct:.1f}",
                "rul": int(round(float(pr.rul_hours))),
                "uploadedAt": u.uploaded_at.isoformat(),
            }
        )

    return items
