"""
shared.schemas
~~~~~~~~~~~~~~
Pydantic models used by both the API and ML services.
Any change here is automatically picked up by both services at runtime.
"""
from typing import Dict, List, Optional

from pydantic import BaseModel


class TelemetrySample(BaseModel):
    ts: str
    seq: Optional[int] = None
    signals: Dict[str, float]


class WindowData(BaseModel):
    start_ts: str
    end_ts: str
    samples: List[TelemetrySample]
