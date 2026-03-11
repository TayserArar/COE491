# ──────────────────────────────────────────────────────────────────
# api/app/main.py  –  Application factory (refactored)
# ──────────────────────────────────────────────────────────────────
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from .db import engine, Base, get_db
from .settings import settings
from .auth import hash_password
from . import models

from .routers.auth_router import router as auth_router
from .routers.upload_router import router as upload_router

# ── Logging ──────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("api")


# ── Startup helpers ──────────────────────────────────────────────

def _ensure_default_users(db):
    """Create the default admin & engineer accounts if they don't exist."""
    for email, name, role, password, department in [
        (settings.admin_email, settings.admin_name, "admin", settings.admin_password, "IT"),
        (settings.engineer_email, settings.engineer_name, "engineer", settings.engineer_password, settings.engineer_department),
    ]:
        if not db.query(models.User).filter(models.User.email == email).first():
            db.add(
                models.User(
                    name=name,
                    email=email,
                    role=role,
                    department=department,
                    hashed_password=hash_password(password),
                    is_active=True,
                )
            )
            logger.info("Created default %s user: %s", role, email)
    db.commit()


def _ensure_prediction_metrics_column():
    """Add the `metrics` column to prediction_runs if it doesn't exist."""
    try:
        with engine.connect() as conn:
            conn.execute(text(
                "ALTER TABLE prediction_runs ADD COLUMN IF NOT EXISTS "
                "metrics JSON DEFAULT '{}'"
            ))
            conn.commit()
    except Exception:
        logger.debug("metrics column migration skipped (may already exist)")


# ── Lifespan ─────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Modern lifespan handler replacing deprecated @app.on_event('startup')."""
    logger.info("Starting up API service …")
    Base.metadata.create_all(bind=engine)      # Quick-start only. Replace with Alembic later.
    _ensure_prediction_metrics_column()
    db = next(get_db())
    try:
        _ensure_default_users(db)
    finally:
        db.close()
    logger.info("API startup complete")
    yield
    logger.info("Shutting down API service …")


# ── Application ──────────────────────────────────────────────────

app = FastAPI(
    title="DANS API",
    version="1.1.0",
    lifespan=lifespan,
)

origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(upload_router)


# ── Health ───────────────────────────────────────────────────────

@app.get("/health")
def healthcheck():
    return {"status": "ok"}
