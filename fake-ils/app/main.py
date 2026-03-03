"""
fake-ils  – MQTT log replayer + HTTP control API

HTTP API (port 8082):
  GET  /health          → {"status": "ok"}
  GET  /v1/months       → {"months": ["2025-01", ...], "active": "2025-03" | null}
  POST /v1/month        → body {"month": "2025-03" | null}  →  restart replay with new filter
"""
import csv
import json
import logging
import os
import re
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional
from zoneinfo import ZoneInfo

import paho.mqtt.client as mqtt
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("fake-ils")

# ── Configuration from environment ───────────────────────────────
MQTT_HOST = os.getenv("MQTT_HOST", "mqtt-broker")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USER = os.getenv("MQTT_USER", "producer")
MQTT_PASS = os.getenv("MQTT_PASS", "producer_pass")

RATE_HZ   = float(os.getenv("RATE_HZ", "5"))
LOOP      = os.getenv("LOOP", "true").strip().lower() in {"1", "true", "yes", "y"}
SOURCE_ID = os.getenv("SOURCE_ID", "fake-ils-01")
LLZ_DIR   = os.getenv("LLZ_DIR", "/data/llz_logs")
GP_DIR    = os.getenv("GP_DIR",  "/data/gp_logs")
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:8081,http://127.0.0.1:8081")

FILENAME_RE = re.compile(r"ContMon\s+(\d{4}-\d{2}-\d{2})-([ab])\.log", re.IGNORECASE)
MONTH_RE    = re.compile(r"(\d{4}-\d{2})")
UAE_TZ      = ZoneInfo("Asia/Dubai")

# ── Mutable state (guarded by _state_lock) ───────────────────────
_state_lock   = threading.Lock()
_month_filter: Optional[str] = None          # e.g. "2025-03" or None = all
_stop_event   = threading.Event()            # set to kill replay threads
_mqtt_client: Optional[mqtt.Client] = None


# ── File helpers ─────────────────────────────────────────────────

def _parse_timestamp(value: str) -> Optional[str]:
    text = value.strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            dt = datetime.strptime(text, fmt)
            return dt.replace(tzinfo=UAE_TZ).isoformat()
        except ValueError:
            continue
    return None


def _convert_value(value: str) -> Optional[float]:
    text = (value or "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _iter_rows(path: str) -> Iterable[Dict[str, str]]:
    with open(path, "r", encoding="latin-1", newline="") as handle:
        header: Optional[List[str]] = None
        for line in handle:
            if "Timestamp" in line:
                header = [h.strip() for h in line.rstrip("\n").split("\t")]
                if header:
                    header[0] = header[0].lstrip("\ufeff")
                break
        if not header:
            raise RuntimeError(f"Header not found in {path}")
        reader = csv.reader(handle, delimiter="\t")
        for row in reader:
            if not row:
                continue
            if len(row) < len(header):
                row = row + [""] * (len(header) - len(row))
            yield dict(zip(header, row))


def _build_message(subsystem: str, row: Dict[str, str], seq: int) -> Dict[str, Any]:
    ts_raw = row.get("Timestamp") or ""
    ts = _parse_timestamp(ts_raw)
    if not ts:
        return {}
    signals = {}
    for key, value in row.items():
        key_name = (key or "").strip()
        if not key_name or key_name == "Timestamp" or key_name.lower() == "status":
            continue
        numeric = _convert_value(value or "")
        if numeric is None:
            continue
        signals[key_name] = numeric
    return {
        "source_id": SOURCE_ID,
        "subsystem": subsystem,
        "ts": ts,
        "seq": seq,
        "signals": signals,
    }


def _collect_files(directory: str, month: Optional[str] = None) -> List[str]:
    """Return sorted log file paths, optionally filtered to a specific YYYY-MM month."""
    if not os.path.isdir(directory):
        return []
    files = []
    for root, _, filenames in os.walk(directory):
        for name in filenames:
            if not name.lower().endswith(".log"):
                continue
            full_path = os.path.join(root, name)
            match = FILENAME_RE.search(name)
            if match:
                date_part = match.group(1)       # e.g. "2025-03-14"
                file_month = date_part[:7]        # e.g. "2025-03"
                if month and file_month != month:
                    continue                      # skip files outside the selected month
                period = match.group(2).lower()
                files.append((date_part, period, full_path))
            else:
                if not month:                    # include unrecognised files only when streaming all
                    files.append(("9999-99-99", "z", full_path))
    files.sort(key=lambda item: (item[0], item[1], item[2]))
    return [path for _, __, path in files]


def _available_months() -> List[str]:
    """Return sorted list of YYYY-MM strings that have files in BOTH LLZ and GP dirs."""
    months: set[str] = set()
    for directory in (LLZ_DIR, GP_DIR):
        if not os.path.isdir(directory):
            continue
        for root, _, filenames in os.walk(directory):
            for name in filenames:
                m = FILENAME_RE.search(name)
                if m:
                    months.add(m.group(1)[:7])
    return sorted(months)


# ── Replay loop ───────────────────────────────────────────────────

def _replay(subsystem: str, client: mqtt.Client, stop: threading.Event) -> None:
    if RATE_HZ <= 0:
        raise ValueError("RATE_HZ must be > 0")
    topic    = f"ils/{subsystem}/telemetry"
    seq      = 1
    interval = 1.0 / RATE_HZ

    while not stop.is_set():
        with _state_lock:
            month = _month_filter
        sources = _collect_files(LLZ_DIR if subsystem == "llz" else GP_DIR, month)
        if not sources:
            logger.warning(
                "[%s] No log files for filter month=%s — retrying in 5 s", subsystem, month
            )
            stop.wait(5)
            continue

        for source in sources:
            if stop.is_set():
                return
            logger.info("Replaying %s from %s (month=%s)", subsystem, source, month)
            for row in _iter_rows(source):
                if stop.is_set():
                    return
                payload = _build_message(subsystem, row, seq)
                if not payload or not payload.get("signals"):
                    continue
                client.publish(topic, json.dumps(payload), qos=1, retain=False)
                seq += 1
                stop.wait(interval)   # interruptible sleep

        if not LOOP:
            break


# ── Thread management ─────────────────────────────────────────────

def _start_replay_threads(client: mqtt.Client) -> threading.Event:
    stop = threading.Event()
    for sub in ("llz", "gp"):
        t = threading.Thread(target=_replay, args=(sub, client, stop), daemon=True)
        t.start()
    return stop


# ── FastAPI app ───────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _mqtt_client, _stop_event

    client = mqtt.Client()
    client.username_pw_set(MQTT_USER, MQTT_PASS)
    client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    client.loop_start()
    _mqtt_client = client

    _stop_event = _start_replay_threads(client)
    logger.info("Fake-ILS replay started (month_filter=%s)", _month_filter)
    yield
    # Shutdown
    _stop_event.set()
    client.loop_stop()
    client.disconnect()
    logger.info("Fake-ILS stopped")


cors_allow = [o.strip() for o in CORS_ORIGINS.split(",") if o.strip()]

app = FastAPI(title="Fake-ILS Control API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_allow,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/v1/months")
def list_months():
    with _state_lock:
        active = _month_filter
    return {"months": _available_months(), "active": active}


class MonthRequest(BaseModel):
    month: Optional[str] = None   # "2025-03" or null to stream all


@app.post("/v1/month")
def set_month(req: MonthRequest):
    global _stop_event, _month_filter

    # Validate format when a specific month is given
    if req.month is not None:
        if not re.fullmatch(r"\d{4}-\d{2}", req.month):
            from fastapi import HTTPException
            raise HTTPException(status_code=400, detail="month must be YYYY-MM or null")
        if req.month not in _available_months():
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail=f"No data found for month {req.month}")

    with _state_lock:
        _month_filter = req.month

    # Kill current replay threads and start fresh with the new filter
    _stop_event.set()                                        # signal old threads to stop
    time.sleep(0.2)                                          # brief grace period
    _stop_event = _start_replay_threads(_mqtt_client)        # start new threads
    logger.info("Month filter changed to %s — replay restarted", req.month)

    return {"status": "ok", "active": req.month}
