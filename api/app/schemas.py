from pydantic import BaseModel
from typing import Any, Dict, List, Optional

class Issue(BaseModel):
    type: str
    severity: str
    description: str
    recommendation: str


class PredictRequest(BaseModel):
    subsystem: str
    features: Dict[str, Any]
    metadata: Dict[str, Any] = {}

class PredictResponse(BaseModel):
    prediction: str
    confidence: float
    rul_hours: float
    anomaly_rate: float
    issues: List[Issue]
    model_version: str

class UploadResponse(BaseModel):
    upload_id: int
    filename: str
    subsystem: str
    features: Dict[str, Any]
    ml: PredictResponse

class Analysis(BaseModel):
    prediction: str
    confidence: str
    rul: int
    severity: str
    recordCount: int
    alarmRate: str
    warningRate: str
    statusCounts: Dict[str, int]
    timeRange: Dict[str, str]
    issues: List[Issue]

class DayDataResponse(BaseModel):
    morning: Optional[Analysis] = None
    afternoon: Optional[Analysis] = None
    combined: Optional[Analysis] = None

class HistoryItem(BaseModel):
    uploadId: int
    filename: str
    dateStr: str
    period: str
    periodLabel: str
    recordCount: int
    prediction: str
    confidence: str
    rul: int
    uploadedAt: str