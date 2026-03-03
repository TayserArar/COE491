# api/app/routers/auth_router.py

from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..settings import settings
from ..auth import verify_password, hash_password, create_access_token
from ..deps import require_user, require_admin
from ..helpers import to_uae_iso, user_to_response, log_audit
from .. import models, schemas

router = APIRouter()


@router.post("/auth/login", response_model=schemas.LoginResponse)
def login(req: schemas.LoginRequest, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.email == req.email).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not verify_password(req.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    user.last_login_at = datetime.now(timezone.utc)
    db.add(user)
    log_audit(db, user, "login", {"email": user.email})
    db.commit()

    token = create_access_token(
        subject=user.email,
        role=user.role,
        secret=settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
        expires_minutes=settings.jwt_expires_minutes,
    )
    return {"access_token": token, "token_type": "bearer", "user": user_to_response(user)}


@router.get("/auth/me", response_model=schemas.UserResponse)
def me(current_user: models.User = Depends(require_user)):
    return user_to_response(current_user)


@router.get("/v1/users", response_model=List[schemas.UserResponse])
def list_users(_: models.User = Depends(require_admin), db: Session = Depends(get_db)):
    users = db.query(models.User).order_by(models.User.created_at.desc()).all()
    return [user_to_response(u) for u in users]


@router.post("/v1/users", response_model=schemas.UserResponse)
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
    log_audit(
        db,
        current_user,
        "user.create",
        {"targetEmail": user.email, "role": user.role},
    )
    db.commit()
    db.refresh(user)
    return user_to_response(user)


@router.patch("/v1/users/{user_id}", response_model=schemas.UserResponse)
def update_user(
    user_id: int,
    req: schemas.UserUpdateRequest,
    current_user: models.User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    updated_fields = []
    if req.email and req.email != user.email:
        if db.query(models.User).filter(models.User.email == req.email).first():
            raise HTTPException(status_code=409, detail="Email already exists")
        user.email = req.email
        updated_fields.append("email")

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
    log_audit(
        db,
        current_user,
        "user.update",
        {"targetEmail": user.email, "fields": updated_fields},
    )
    db.commit()
    db.refresh(user)
    return user_to_response(user)


@router.delete("/v1/users/{user_id}")
def delete_user(
    user_id: int,
    current_user: models.User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    if user.role == "admin":
        admin_count = db.query(models.User).filter(models.User.role == "admin").count()
        if admin_count <= 1:
            raise HTTPException(status_code=400, detail="Cannot delete the last admin user")

    target_email = user.email
    target_role = user.role
    db.query(models.AuditLog).filter(models.AuditLog.actor_user_id == user.id).update(
        {models.AuditLog.actor_user_id: None},
        synchronize_session=False,
    )
    db.delete(user)
    log_audit(
        db,
        current_user,
        "user.delete",
        {"targetEmail": target_email, "role": target_role},
    )
    db.commit()
    return {"status": "ok"}


@router.post("/v1/users/{user_id}/reset-password")
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
    log_audit(db, current_user, "user.reset_password", {"targetEmail": user.email})
    db.commit()
    return {"status": "ok"}


@router.get("/v1/audit", response_model=List[schemas.AuditLogResponse])
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
                createdAt=to_uae_iso(log.created_at),
            )
        )
    return out
