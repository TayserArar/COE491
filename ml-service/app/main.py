from fastapi import FastAPI
from pydantic import BaseModel
from typing import Any, Dict, List, Optional
from datetime import datetime, timezone
import math

app = FastAPI(title="ML Service", version="0.1")

class TelemetrySample(BaseModel):
    ts: str
    seq: Optional[int] = None
    signals: Dict[str, float]


class WindowData(BaseModel):
    start_ts: str
    end_ts: str
    samples: List[TelemetrySample]


class PredictRequest(BaseModel):
    subsystem: str
    features: Optional[Dict[str, Any]] = None
    window: Optional[WindowData] = None
    metadata: Dict[str, Any] = {}

@app.get("/health")
def health():
    return {"status": "ok"}


def _parse_ts(value: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _extract_window_features(window: WindowData) -> Dict[str, Any]:
    samples = window.samples or []
    signal_values: Dict[str, List[float]] = {}

    for sample in samples:
        for name, value in (sample.signals or {}).items():
            if isinstance(value, (int, float)) and not math.isnan(value):
                signal_values.setdefault(name, []).append(float(value))

    signal_stats = {}
    for name, values in signal_values.items():
        if not values:
            continue
        mean = sum(values) / len(values)
        variance = sum((v - mean) ** 2 for v in values) / max(1, len(values) - 1)
        std = math.sqrt(variance)
        min_val = min(values)
        max_val = max(values)
        signal_stats[name] = {
            "mean": mean,
            "std": std,
            "min": min_val,
            "max": max_val,
            "range": max_val - min_val,
        }

    start_dt = _parse_ts(window.start_ts)
    end_dt = _parse_ts(window.end_ts)
    duration_sec = None
    if start_dt and end_dt:
        duration_sec = max(0.0, (end_dt - start_dt).total_seconds())

    return {
        "sample_count": len(samples),
        "signal_count": len(signal_values),
        "signal_stats": signal_stats,
        "window_duration_sec": duration_sec,
    }


def _score_window(features: Dict[str, Any]) -> Dict[str, Any]:
    stats = features.get("signal_stats", {}) or {}
    best_signal = None
    best_range_ratio = 0.0
    best_std_ratio = 0.0

    for name, info in stats.items():
        mean = float(info.get("mean", 0.0))
        std = float(info.get("std", 0.0))
        value_range = float(info.get("range", 0.0))
        denom = abs(mean) + 1e-6
        range_ratio = value_range / denom
        std_ratio = std / denom
        if range_ratio > best_range_ratio:
            best_range_ratio = range_ratio
            best_std_ratio = std_ratio
            best_signal = name

    fault_score = max(best_range_ratio, best_std_ratio)
    anomaly_rate = min(1.0, fault_score / 3.0) if fault_score > 0 else 0.0

    fault_type = None
    if fault_score >= 2.5:
        if best_range_ratio >= 2.5 and best_std_ratio < 1.0:
            fault_type = "signal_spike"
        elif best_std_ratio >= 1.5:
            fault_type = "signal_noise"
        else:
            fault_type = "signal_drift"

    return {
        "fault_score": fault_score,
        "anomaly_rate": anomaly_rate,
        "fault_type": fault_type,
        "fault_signal": best_signal,
    }


@app.post("/v1/predict")
def predict(req: PredictRequest):
    features = req.features or {}

    if req.window is not None:
        window_features = _extract_window_features(req.window)
        features = {**features, **window_features}

    scored = _score_window(features) if features.get("signal_stats") else None
    anomaly_rate = float(
        (scored or {}).get("anomaly_rate", features.get("anomaly_rate", 0.0))
    )

    pred = "NORMAL"
    confidence = 0.7
    rul = 720.0
    issues: List[dict] = []

    if scored and scored.get("fault_type"):
        pred = "FAULT"
        confidence = min(0.95, 0.75 + (scored["fault_score"] / 10.0))
        rul = 24.0
        fault_type = scored["fault_type"]
        fault_signal = scored.get("fault_signal") or "unknown"
        issues.append(
            {
                "type": fault_type,
                "severity": "high",
                "description": f"Detected {fault_type.replace('_', ' ')} on {fault_signal}.",
                "recommendation": "Inspect subsystem and review signal behavior in the 5-minute window.",
            }
        )

    return {
        "prediction": pred,
        "confidence": confidence,
        "rul_hours": rul,
        "anomaly_rate": anomaly_rate,
        "fault_type": (scored or {}).get("fault_type") if pred == "FAULT" else None,
        "issues": issues,
        "model_version": "stub-0.2"
    }
