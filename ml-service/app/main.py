from fastapi import FastAPI
from pydantic import BaseModel
from typing import Any, Dict, List

app = FastAPI(title="ML Service", version="0.1")

class PredictRequest(BaseModel):
    subsystem: str
    features: Dict[str, Any]
    metadata: Dict[str, Any] = {}

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/v1/predict")
def predict(req: PredictRequest):
    anomaly_rate = float(req.features.get("anomaly_rate", 0.0))

    if anomaly_rate >= 0.7:
        pred = "FAULT"
        confidence = 0.92
        rul = 24.0
        issues: List[dict] = [{
            "type": "high_anomaly_rate",
            "severity": "high",
            "description": "Anomaly rate is very high based on log heuristics.",
            "recommendation": "Inspect subsystem immediately; consider controlled shutdown."
        }]
    elif anomaly_rate >= 0.3:
        pred = "WARNING"
        confidence = 0.85
        rul = 240.0
        issues = [{
            "type": "moderate_anomaly_rate",
            "severity": "medium",
            "description": "Anomaly rate is elevated based on log heuristics.",
            "recommendation": "Schedule inspection and monitor more frequently."
        }]
    else:
        pred = "NORMAL"
        confidence = 0.75
        rul = 720.0
        issues = []

    return {
        "prediction": pred,
        "confidence": confidence,
        "rul_hours": rul,
        "anomaly_rate": anomaly_rate,
        "issues": issues,
        "model_version": "stub-0.1"
    }
