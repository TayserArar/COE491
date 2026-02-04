# api/app/main.py

import os
import re
from datetime import datetime, timezone
from typing import List

import httpx
from fastapi import FastAPI, UploadFile, File, Depends, HTTPException, Query, Header
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from .settings import settings
from .db import Base, engine, get_db
from . import models
from . import schemas
from .auth import verify_password, hash_password, create_access_token, decode_token


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
    _ensure_default_users()


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


def parse_iso_date(value: str) -> str:
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt.date().isoformat()
    except ValueError:
        return datetime.now(timezone.utc).date().isoformat()


def normalize_confidence(conf: float) -> float:
    """
    If ML returns 0..1, convert to 0..100. If it returns already percent, keep it.
    """
    return conf * 100.0 if conf <= 1.0 else conf


def extract_fault_type(issues: object) -> str | None:
    if isinstance(issues, dict) and "items" in issues:
        issues = issues["items"]
    if isinstance(issues, list) and issues:
        first = issues[0]
        if isinstance(first, dict):
            return first.get("type")
    return None


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


def _user_to_response(user: models.User) -> schemas.UserResponse:
    return schemas.UserResponse(
        id=user.id,
        name=user.name,
        email=user.email,
        role=user.role,
        department=user.department,
        isActive=user.is_active,
        createdAt=user.created_at.isoformat(),
        lastLoginAt=user.last_login_at.isoformat() if user.last_login_at else None,
    )


def _log_audit(db: Session, actor: models.User | None, action: str, details: dict | None = None) -> None:
    log = models.AuditLog(
        actor_user_id=actor.id if actor else None,
        action=action,
        details=details or {},
    )
    db.add(log)


def _ensure_default_users() -> None:
    db = next(get_db())
    try:
        admin = db.query(models.User).filter(models.User.email == settings.admin_email).first()
        if not admin:
            admin = models.User(
                name=settings.admin_name,
                email=settings.admin_email,
                role="admin",
                department="Operations",
                hashed_password=hash_password(settings.admin_password),
                is_active=True,
            )
            db.add(admin)
            db.commit()

        engineer = db.query(models.User).filter(models.User.email == settings.engineer_email).first()
        if not engineer:
            engineer = models.User(
                name=settings.engineer_name,
                email=settings.engineer_email,
                role="engineer",
                department=settings.engineer_department,
                hashed_password=hash_password(settings.engineer_password),
                is_active=True,
            )
            db.add(engineer)
            db.commit()
    finally:
        db.close()


def _get_current_user(
    authorization: str | None,
    db: Session,
) -> models.User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    payload = decode_token(token, settings.jwt_secret, settings.jwt_algorithm)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid token")
    email = payload.get("sub")
    if not email:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = db.query(models.User).filter(models.User.email == email).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=403, detail="User inactive or not found")
    return user


def require_user(
    authorization: str = Header(None),
    db: Session = Depends(get_db),
) -> models.User:
    return _get_current_user(authorization, db)


def require_admin(current_user: models.User = Depends(require_user)) -> models.User:
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user


def require_user_or_ingestion(
    authorization: str = Header(None),
    x_api_key: str | None = Header(None, alias="X-API-Key"),
    db: Session = Depends(get_db),
) -> models.User | None:
    if x_api_key and x_api_key == settings.ingestion_api_key:
        return None
    return _get_current_user(authorization, db)


# ---------------------------
# Auth
# ---------------------------
@app.post("/auth/login", response_model=schemas.LoginResponse)
def login(req: schemas.LoginRequest, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.email == req.email).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not verify_password(req.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    user.last_login_at = datetime.utcnow()
    db.add(user)
    _log_audit(db, user, "login", {"email": user.email})
    db.commit()

    token = create_access_token(
        subject=user.email,
        role=user.role,
        secret=settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
        expires_minutes=settings.jwt_expires_minutes,
    )
    return {"access_token": token, "token_type": "bearer", "user": _user_to_response(user)}


@app.get("/auth/me", response_model=schemas.UserResponse)
def me(current_user: models.User = Depends(require_user)):
    return _user_to_response(current_user)


@app.get("/v1/users", response_model=List[schemas.UserResponse])
def list_users(_: models.User = Depends(require_admin), db: Session = Depends(get_db)):
    users = db.query(models.User).order_by(models.User.created_at.desc()).all()
    return [_user_to_response(u) for u in users]


@app.post("/v1/users", response_model=schemas.UserResponse)
def create_user(
    req: schemas.UserCreateRequest,
    current_user: models.User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if db.query(models.User).filter(models.User.email == req.email).first():
        raise HTTPException(status_code=409, detail="Email already exists")
    if len(req.password) < 8:
        raise HTTPException(status_code=400, detail="Password too short")
    if req.role not in {"admin", "engineer"}:
        raise HTTPException(status_code=400, detail="Invalid role")

    user = models.User(
        name=req.name,
        email=req.email,
        role=req.role,
        department=req.department,
        hashed_password=hash_password(req.password),
        is_active=req.isActive,
    )
    db.add(user)
    db.flush()
    _log_audit(
        db,
        current_user,
        "user.create",
        {"targetEmail": user.email, "role": user.role},
    )
    db.commit()
    db.refresh(user)
    return _user_to_response(user)


@app.patch("/v1/users/{user_id}", response_model=schemas.UserResponse)
def update_user(
    user_id: int,
    req: schemas.UserUpdateRequest,
    current_user: models.User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if req.email and req.email != user.email:
        if db.query(models.User).filter(models.User.email == req.email).first():
            raise HTTPException(status_code=409, detail="Email already exists")
        user.email = req.email
        updated_fields.append("email")

    updated_fields = []
    if req.name is not None:
        user.name = req.name
        updated_fields.append("name")
    if req.role is not None:
        if req.role not in {"admin", "engineer"}:
            raise HTTPException(status_code=400, detail="Invalid role")
        user.role = req.role
        updated_fields.append("role")
    if req.department is not None:
        user.department = req.department
        updated_fields.append("department")
    if req.isActive is not None:
        user.is_active = req.isActive
        updated_fields.append("isActive")

    db.add(user)
    _log_audit(
        db,
        current_user,
        "user.update",
        {"targetEmail": user.email, "fields": updated_fields},
    )
    db.commit()
    db.refresh(user)
    return _user_to_response(user)


@app.post("/v1/users/{user_id}/reset-password")
def reset_password(
    user_id: int,
    req: schemas.PasswordResetRequest,
    current_user: models.User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if len(req.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password too short")

    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.hashed_password = hash_password(req.new_password)
    db.add(user)
    _log_audit(db, current_user, "user.reset_password", {"targetEmail": user.email})
    db.commit()
    return {"status": "ok"}


@app.get("/v1/audit", response_model=List[schemas.AuditLogResponse])
def get_audit_logs(
    limit: int = Query(100, ge=1, le=500),
    _: models.User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    logs = (
        db.query(models.AuditLog)
        .order_by(models.AuditLog.created_at.desc())
        .limit(limit)
        .all()
    )
    out: List[schemas.AuditLogResponse] = []
    for log in logs:
        actor = log.actor
        out.append(
            schemas.AuditLogResponse(
                id=log.id,
                actorId=actor.id if actor else None,
                actorName=actor.name if actor else None,
                actorEmail=actor.email if actor else None,
                action=log.action,
                metadata=log.details or {},
                createdAt=log.created_at.isoformat(),
            )
        )
    return out


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
    fault_type = extract_fault_type(issues)

    return {
        "prediction": pred,
        "faultType": fault_type,
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

    combined_issues = (morning.get("issues") or []) + (afternoon.get("issues") or [])

    return {
        "prediction": prediction,
        "faultType": extract_fault_type(combined_issues),
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
        "issues": combined_issues,
    }


# ---------------------------
# Upload + Analyze
# ---------------------------
@app.post("/v1/uploads", response_model=schemas.UploadResponse)
async def upload_file(
    file: UploadFile = File(...),
    subsystem: str = "GP",
    db: Session = Depends(get_db),
    _: models.User = Depends(require_user),
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
def get_dates_with_data(db: Session = Depends(get_db), _: models.User = Depends(require_user)):
    rows = (
        db.query(models.Upload.date_str)
        .filter(models.Upload.date_str.isnot(None))
        .distinct()
        .order_by(models.Upload.date_str.asc())
        .all()
    )
    return [r[0] for r in rows if r and r[0]]


@app.get("/v1/days/{date_str}", response_model=schemas.DayDataResponse)
def get_day(date_str: str, db: Session = Depends(get_db), _: models.User = Depends(require_user)):
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
                "confidence": f"{conf_pct:.1f}",
                "rul": int(round(float(pr.rul_hours))),
                "uploadedAt": u.uploaded_at.isoformat(),
            }
        )

    return items


# ---------------------------
# Telemetry window ingest
# ---------------------------
@app.post("/v1/telemetry/windows", response_model=schemas.UploadResponse)
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
            rul_hours=float(ml["rul_hours"]),
            anomaly_rate=float(ml.get("anomaly_rate", 0.0)),
            issues=ml.get("issues", []),
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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
