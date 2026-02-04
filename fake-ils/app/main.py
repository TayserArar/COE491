import csv
import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

import paho.mqtt.client as mqtt

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("fake-ils")

MQTT_HOST = os.getenv("MQTT_HOST", "mqtt-broker")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USER = os.getenv("MQTT_USER", "producer")
MQTT_PASS = os.getenv("MQTT_PASS", "producer_pass")

RATE_HZ = float(os.getenv("RATE_HZ", "5"))
LOOP = os.getenv("LOOP", "true").strip().lower() in {"1", "true", "yes", "y"}
SOURCE_ID = os.getenv("SOURCE_ID", "fake-ils-01")
LLZ_FILE = os.getenv("LLZ_FILE")
GP_FILE = os.getenv("GP_FILE")
LLZ_DIR = os.getenv("LLZ_DIR", "/data/llz_logs")
GP_DIR = os.getenv("GP_DIR", "/data/gp_logs")
HEADER_LINES = int(os.getenv("HEADER_LINES", "17"))

FILENAME_RE = re.compile(r"ContMon\s+(\\d{4}-\\d{2}-\\d{2})-([ab])\\.log", re.IGNORECASE)


def _parse_timestamp(value: str) -> Optional[str]:
    text = value.strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            dt = datetime.strptime(text, fmt)
            return dt.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
        except ValueError:
            continue
    return None


def _convert_value(value: str) -> Optional[float]:
    if value is None:
        return None
    text = value.strip()
    if text == "":
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
    ts_value = row.get("Timestamp") if row.get("Timestamp") else None
    ts = _parse_timestamp(ts_value or "")
    if not ts:
        return {}
    signals = {}
    for key, value in row.items():
        if not key:
            continue
        key_name = key.strip()
        if key_name == "Timestamp" or key_name.lower() == "status":
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


def _collect_files(directory: str) -> List[str]:
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
                date_part = match.group(1)
                period = match.group(2).lower()
                files.append((date_part, period, full_path))
            else:
                files.append(("9999-99-99", "z", full_path))
    files.sort(key=lambda item: (item[0], item[1], item[2]))
    return [path for _, __, path in files]


def _resolve_sources(subsystem: str) -> List[str]:
    if subsystem == "llz" and LLZ_FILE:
        return [LLZ_FILE]
    if subsystem == "gp" and GP_FILE:
        return [GP_FILE]
    directory = LLZ_DIR if subsystem == "llz" else GP_DIR
    return _collect_files(directory)


def _replay(subsystem: str, client: mqtt.Client) -> None:
    if RATE_HZ <= 0:
        raise ValueError("RATE_HZ must be > 0")

    topic = f"ils/{subsystem}/telemetry"
    seq = 1
    interval = 1.0 / RATE_HZ

    while True:
        sources = _resolve_sources(subsystem)
        if not sources:
            raise RuntimeError(f"No log files found for {subsystem} in configured path")
        for source in sources:
            logger.info("Replaying %s from %s", subsystem, source)
            for row in _iter_rows(source):
                payload = _build_message(subsystem, row, seq)
                if not payload or not payload.get("signals"):
                    continue
                client.publish(topic, json.dumps(payload), qos=1, retain=False)
                logger.info("Published %s seq=%s", topic, seq)
                seq += 1
                time.sleep(interval)
        if not LOOP:
            break


def main() -> None:
    client = mqtt.Client()
    client.username_pw_set(MQTT_USER, MQTT_PASS)
    client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    client.loop_start()

    llz_thread = threading.Thread(target=_replay, args=("llz", client), daemon=True)
    gp_thread = threading.Thread(target=_replay, args=("gp", client), daemon=True)

    llz_thread.start()
    gp_thread.start()

    llz_thread.join()
    gp_thread.join()


if __name__ == "__main__":
    main()
