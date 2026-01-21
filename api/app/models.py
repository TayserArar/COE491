from sqlalchemy import String, DateTime, ForeignKey, JSON, Float
from sqlalchemy.orm import Mapped, mapped_column, relationship
from datetime import datetime
from .db import Base

class Upload(Base):
    __tablename__ = "uploads"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    filename: Mapped[str] = mapped_column(String(255))
    subsystem: Mapped[str] = mapped_column(String(50), default="GP")

    # NEW: date navigation fields
    date_str: Mapped[str] = mapped_column(String(10), index=True)  # YYYY-MM-DD
    period: Mapped[str] = mapped_column(String(20), index=True, default="unknown")  # morning/afternoon/unknown
    period_label: Mapped[str] = mapped_column(String(30), default="Unknown Period")

    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    file_path: Mapped[str] = mapped_column(String(500))
    parsed_features: Mapped[dict] = mapped_column(JSON, default=dict)

    prediction = relationship("PredictionRun", back_populates="upload", uselist=False)

class PredictionRun(Base):
    __tablename__ = "prediction_runs"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    upload_id: Mapped[int] = mapped_column(ForeignKey("uploads.id"))
    model_version: Mapped[str] = mapped_column(String(50), default="stub-0.1")

    prediction: Mapped[str] = mapped_column(String(20))
    confidence: Mapped[float] = mapped_column(Float)     # stored as 0..1 (or 0..100 later)
    rul_hours: Mapped[float] = mapped_column(Float)
    anomaly_rate: Mapped[float] = mapped_column(Float)

    # store list or dict; JSON supports both
    issues: Mapped[object] = mapped_column(JSON, default=list)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    upload = relationship("Upload", back_populates="prediction")
