from pydantic import BaseModel
from typing import Any, Dict, List, Optional

class Issue(BaseModel):
    type: str
    severity: str
    description: str
    recommendation: str


class TelemetrySample(BaseModel):
    ts: str
    seq: Optional[int] = None
    signals: Dict[str, float]


class WindowData(BaseModel):
    start_ts: str
    end_ts: str
    samples: List[TelemetrySample]


class TelemetryWindowRequest(BaseModel):
    subsystem: str
    window: WindowData
    metadata: Dict[str, Any] = {}


class PredictRequest(BaseModel):
    subsystem: str
    features: Dict[str, Any]
    metadata: Dict[str, Any] = {}


class LoginRequest(BaseModel):
    email: str
    password: str


class UserResponse(BaseModel):
    id: int
    name: str
    email: str
    role: str
    department: str
    isActive: bool
    createdAt: str
    lastLoginAt: Optional[str] = None


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


class UserCreateRequest(BaseModel):
    name: str
    email: str
    role: str = "engineer"
    department: str = "Operations"
    password: str
    isActive: bool = True


class UserUpdateRequest(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    role: Optional[str] = None
    department: Optional[str] = None
    isActive: Optional[bool] = None


class PasswordResetRequest(BaseModel):
    new_password: str


class AuditLogResponse(BaseModel):
    id: int
    actorId: Optional[int] = None
    actorName: Optional[str] = None
    actorEmail: Optional[str] = None
    action: str
    metadata: Dict[str, Any] = {}
    createdAt: str

class PredictResponse(BaseModel):
    prediction: str
    fault_type: Optional[str] = None
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
    faultType: Optional[str] = None
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
    subsystem: str
    dateStr: str
    period: str
    periodLabel: str
    recordCount: int
    prediction: str
    faultType: Optional[str] = None
    anomalyRate: Optional[float] = None
    confidence: str
    rul: int
    uploadedAt: str
