import asyncio
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import paho.mqtt.client as mqtt
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Header
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, text
import httpx
from jose import jwt, JWTError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("ingestion")

MQTT_HOST = os.getenv("MQTT_HOST", "mqtt-broker")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USER = os.getenv("MQTT_USER", "ingestion")
MQTT_PASS = os.getenv("MQTT_PASS", "ingestion_pass")
DATABASE_URL = os.getenv("DATABASE_URL")
API_URL = os.getenv("API_URL", "http://api:8000")
WINDOW_SECONDS = int(os.getenv("WINDOW_SECONDS", "300"))
INGESTION_API_KEY = os.getenv("INGESTION_API_KEY", "")
JWT_SECRET = os.getenv("JWT_SECRET", "change_me")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")

SUBSYSTEMS = {"llz", "gp"}

cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:8081,http://127.0.0.1:8081")
cors_allow = [origin.strip() for origin in cors_origins.split(",") if origin.strip()]

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_allow,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

connections: Dict[WebSocket, str] = {}
connections_lock = asyncio.Lock()

broadcast_queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()
latest_by_subsystem: Dict[str, Dict[str, Any]] = {}
last_seq: Dict[tuple, int] = {}
window_buffers: Dict[str, Dict[str, Any]] = {s: {"start": None, "samples": []} for s in SUBSYSTEMS}
window_lock = threading.Lock()

_event_loop: asyncio.AbstractEventLoop | None = None
_mqtt_client: mqtt.Client | None = None
_db_engine = None
_persist_enabled = False


def _init_db() -> None:
    global _db_engine, _persist_enabled
    if not DATABASE_URL:
        logger.warning("DATABASE_URL not set; telemetry persistence disabled")
        return

    _db_engine = create_engine(DATABASE_URL, pool_pre_ping=True)
    ddl = """
    CREATE TABLE IF NOT EXISTS telemetry_samples (
        id bigserial PRIMARY KEY,
        source_id text NOT NULL,
        subsystem text NOT NULL,
        ts timestamptz NOT NULL,
        seq integer NOT NULL,
        signals jsonb NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_samples_subsystem_ts
        ON telemetry_samples (subsystem, ts);
    CREATE INDEX IF NOT EXISTS idx_telemetry_samples_ts
        ON telemetry_samples (ts);
    """
    for attempt in range(1, 11):
        try:
            with _db_engine.begin() as conn:
                conn.execute(text(ddl))
            _persist_enabled = True
            logger.info("Telemetry persistence enabled")
            return
        except Exception as exc:
            logger.warning("DB not ready (attempt %s/10): %s", attempt, exc)
            time.sleep(1)

    logger.warning("Telemetry persistence disabled; database unavailable")


def _persist_payload(payload: Dict[str, Any]) -> None:
    if not _persist_enabled or _db_engine is None:
        return
    try:
        with _db_engine.begin() as conn:
            conn.execute(
                text(
                    """
                    INSERT INTO telemetry_samples (source_id, subsystem, ts, seq, signals)
                    VALUES (:source_id, :subsystem, CAST(:ts AS timestamptz), :seq, CAST(:signals AS jsonb))
                    """
                ),
                {
                    "source_id": payload["source_id"],
                    "subsystem": payload["subsystem"],
                    "ts": payload["ts"],
                    "seq": payload["seq"],
                    "signals": json.dumps(payload["signals"]),
                },
            )
    except Exception as exc:
        logger.warning("Failed to persist telemetry: %s", exc)


def _is_valid_iso(ts_value: str) -> bool:
    try:
        datetime.fromisoformat(ts_value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def _validate_payload(payload: Dict[str, Any]) -> bool:
    required = {"source_id", "subsystem", "ts", "seq", "signals"}
    if not required.issubset(payload.keys()):
        return False
    if not isinstance(payload["source_id"], str):
        return False
    if payload["subsystem"] not in SUBSYSTEMS:
        return False
    if not isinstance(payload["ts"], str) or not _is_valid_iso(payload["ts"]):
        return False
    if not isinstance(payload["seq"], int):
        return False
    if not isinstance(payload["signals"], dict):
        return False
    return True


def _parse_ts(ts_value: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(ts_value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _should_accept(payload: Dict[str, Any]) -> bool:
    key = (payload["source_id"], payload["subsystem"])
    prev = last_seq.get(key)
    if prev is not None and payload["seq"] <= prev:
        return False
    last_seq[key] = payload["seq"]
    return True


def _enqueue_broadcast(message: Dict[str, Any]) -> None:
    if _event_loop is None:
        return

    def _put() -> None:
        try:
            broadcast_queue.put_nowait(message)
        except asyncio.QueueFull:
            logger.warning("Broadcast queue full; dropping message")

    _event_loop.call_soon_threadsafe(_put)


def _on_connect(client: mqtt.Client, userdata: Any, flags: Dict[str, Any], rc: int) -> None:
    if rc == 0:
        client.subscribe("ils/+/telemetry", qos=1)
        logger.info("Subscribed to ils/+/telemetry")
    else:
        logger.error("MQTT connection failed rc=%s", rc)


def _on_message(client: mqtt.Client, userdata: Any, msg: mqtt.MQTTMessage) -> None:
    try:
        payload = json.loads(msg.payload.decode("utf-8"))
    except json.JSONDecodeError:
        logger.warning("Invalid JSON on %s", msg.topic)
        return

    if not isinstance(payload, dict):
        logger.warning("Payload is not an object on %s", msg.topic)
        return

    if not _validate_payload(payload):
        logger.warning("Validation failed on %s", msg.topic)
        return

    if not _should_accept(payload):
        return

    latest_by_subsystem[payload["subsystem"]] = payload
    _persist_payload(payload)
    _buffer_sample(payload)
    _enqueue_broadcast(payload)


def _mqtt_loop() -> None:
    client = mqtt.Client()
    client.username_pw_set(MQTT_USER, MQTT_PASS)
    client.on_connect = _on_connect
    client.on_message = _on_message
    client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    client.loop_forever()


def _buffer_sample(payload: Dict[str, Any]) -> None:
    ts_value = payload.get("ts")
    if not ts_value:
        return
    with window_lock:
        buf = window_buffers.get(payload["subsystem"])
        if buf is None:
            return
        if buf["start"] is None:
            buf["start"] = ts_value
        buf["samples"].append(
            {
                "ts": ts_value,
                "seq": payload.get("seq"),
                "signals": payload.get("signals", {}),
            }
        )


async def _broadcast_worker() -> None:
    while True:
        message = await broadcast_queue.get()
        await _broadcast(message)
        broadcast_queue.task_done()


async def _window_worker() -> None:
    while True:
        await _flush_ready_windows()
        await asyncio.sleep(5)


async def _flush_ready_windows() -> None:
    to_send: List[Dict[str, Any]] = []
    with window_lock:
        for subsystem, buf in window_buffers.items():
            samples = buf["samples"]
            if not samples:
                continue
            start_ts = buf["start"]
            end_ts = samples[-1]["ts"]
            start_dt = _parse_ts(start_ts) if start_ts else None
            end_dt = _parse_ts(end_ts)
            if not start_dt or not end_dt:
                continue
            if (end_dt - start_dt).total_seconds() >= WINDOW_SECONDS:
                to_send.append(
                    {
                        "subsystem": subsystem,
                        "window": {
                            "start_ts": start_ts,
                            "end_ts": end_ts,
                            "samples": samples.copy(),
                        },
                    }
                )
                buf["start"] = None
                buf["samples"] = []

    for payload in to_send:
        await _send_window(payload)


async def _send_window(payload: Dict[str, Any]) -> None:
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            headers = {}
            if INGESTION_API_KEY:
                headers["X-API-Key"] = INGESTION_API_KEY
            response = await client.post(f"{API_URL}/v1/telemetry/windows", json=payload, headers=headers)
            response.raise_for_status()
        logger.info("Sent %s window to API", payload.get("subsystem"))
    except Exception as exc:
        logger.warning("Failed to send window to API: %s", exc)


async def _broadcast(message: Dict[str, Any]) -> None:
    serialized = json.dumps(message)
    to_remove = []
    async with connections_lock:
        for ws, subsystem_filter in connections.items():
            if subsystem_filter != "all" and message.get("subsystem") != subsystem_filter:
                continue
            try:
                await ws.send_text(serialized)
            except Exception:
                to_remove.append(ws)

        for ws in to_remove:
            connections.pop(ws, None)


@app.on_event("startup")
async def startup_event() -> None:
    global _event_loop
    _event_loop = asyncio.get_running_loop()

    _init_db()
    thread = threading.Thread(target=_mqtt_loop, daemon=True)
    thread.start()

    asyncio.create_task(_broadcast_worker())
    asyncio.create_task(_window_worker())
    logger.info("Ingestion service started")


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/latest/{subsystem}")
async def latest(subsystem: str, authorization: str | None = Header(None)) -> Dict[str, Any]:
    if not _validate_bearer_header(authorization):
        raise HTTPException(status_code=401, detail="Unauthorized")
    if subsystem not in SUBSYSTEMS:
        raise HTTPException(status_code=404, detail="Unknown subsystem")

    latest_value = latest_by_subsystem.get(subsystem)
    if latest_value is None:
        raise HTTPException(status_code=404, detail="No data")

    return latest_value


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    subsystem_filter = websocket.query_params.get("subsystem", "all")
    if subsystem_filter not in SUBSYSTEMS and subsystem_filter != "all":
        await websocket.close(code=1008)
        return
    token = websocket.query_params.get("token")
    if not _validate_token(token):
        await websocket.close(code=1008)
        return

    await websocket.accept()
    async with connections_lock:
        connections[websocket] = subsystem_filter

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        async with connections_lock:
            connections.pop(websocket, None)


def _validate_token(token: str | None) -> bool:
    if not token:
        return False
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return bool(payload.get("sub"))
    except JWTError:
        return False


def _validate_bearer_header(authorization: str | None) -> bool:
    if not authorization or not authorization.lower().startswith("bearer "):
        return False
    token = authorization.split(" ", 1)[1].strip()
    return _validate_token(token)
