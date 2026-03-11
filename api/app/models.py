from sqlalchemy import String, DateTime, ForeignKey, JSON, Float, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship
from datetime import datetime, timezone
from .db import Base


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


class Upload(Base):
    __tablename__ = "uploads"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    filename: Mapped[str] = mapped_column(String(255))
    subsystem: Mapped[str] = mapped_column(String(50), default="GP")

    # NEW: date navigation fields
    date_str: Mapped[str] = mapped_column(String(10), index=True)  # YYYY-MM-DD
    period: Mapped[str] = mapped_column(String(20), index=True, default="unknown")  # morning/afternoon/unknown
    period_label: Mapped[str] = mapped_column(String(30), default="Unknown Period")

    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc)
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
    anomaly_rate: Mapped[float] = mapped_column(Float)

    # store list or dict; JSON supports both
    issues: Mapped[object] = mapped_column(JSON, default=list)
    metrics: Mapped[object] = mapped_column(JSON, default=dict)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc)

    upload = relationship("Upload", back_populates="prediction")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    role: Mapped[str] = mapped_column(String(20), default="engineer")  # admin/engineer
    department: Mapped[str] = mapped_column(String(50), default="Operations")
    hashed_password: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc)
    last_login_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=True)

    audit_logs = relationship("AuditLog", back_populates="actor")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(100))
    details: Mapped[object] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now_utc)

    actor = relationship("User", back_populates="audit_logs")
