import asyncio
import json
import logging
import os
import threading
from datetime import datetime
from typing import Any, Dict

import paho.mqtt.client as mqtt
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("ingestion")

MQTT_HOST = os.getenv("MQTT_HOST", "mqtt-broker")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USER = os.getenv("MQTT_USER", "ingestion")
MQTT_PASS = os.getenv("MQTT_PASS", "ingestion_pass")

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

_event_loop: asyncio.AbstractEventLoop | None = None
_mqtt_client: mqtt.Client | None = None


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
    _enqueue_broadcast(payload)


def _mqtt_loop() -> None:
    client = mqtt.Client()
    client.username_pw_set(MQTT_USER, MQTT_PASS)
    client.on_connect = _on_connect
    client.on_message = _on_message
    client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    client.loop_forever()


async def _broadcast_worker() -> None:
    while True:
        message = await broadcast_queue.get()
        await _broadcast(message)
        broadcast_queue.task_done()


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

    thread = threading.Thread(target=_mqtt_loop, daemon=True)
    thread.start()

    asyncio.create_task(_broadcast_worker())
    logger.info("Ingestion service started")


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/latest/{subsystem}")
async def latest(subsystem: str) -> Dict[str, Any]:
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
