# api/app/deps.py  –  Shared dependencies for route handlers

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from .db import get_db
from .settings import settings
from .auth import decode_token
from . import models


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
