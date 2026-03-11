# api/app/helpers.py  –  Shared utility functions

import csv
import os
import re
from datetime import datetime
from typing import Dict, Iterable, List, Optional
from zoneinfo import ZoneInfo

from shared.schemas import TelemetrySample

UAE_TZ = ZoneInfo("Asia/Dubai")


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

    today = datetime.now(UAE_TZ).date().isoformat()
    return today, "unknown", "Unknown Period"


def parse_iso_date(value: str) -> str:
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt.date().isoformat()
    except ValueError:
        return datetime.now(UAE_TZ).date().isoformat()


def to_uae_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UAE_TZ)
    else:
        value = value.astimezone(UAE_TZ)
    return value.isoformat()


def normalize_confidence(conf: float) -> float:
    """
    If ML returns 0..1, convert to 0..100. If it returns already percent, keep it.
    """
    return conf * 100.0 if conf <= 1.0 else conf


def extract_fault_type(issues: object) -> str | None:
    """Return the fault class label from the issues list/dict.

    Handles the dict-with-items wrapper that some older responses use, as well
    as a plain list.  Prefers the ``type`` key (set by both the healthy-model
    path and the new LLZ multiclass path), falling back to ``label``.

    For LLZ multiclass results the ``type`` key holds the *exact* class name
    string (e.g. ``"ANTENNA_FAULT"``), so this function naturally passes it
    through unchanged.
    """
    if isinstance(issues, dict) and "items" in issues:
        issues = issues["items"]
    if not isinstance(issues, list) or not issues:
        return None
    first = issues[0]
    if not isinstance(first, dict):
        return None
    return first.get("type") or first.get("label") or None


def _parse_timestamp(value: str) -> Optional[str]:
    text = value.strip()
    if not text:
        return None

    try:
        dt = datetime.fromisoformat(text.replace(" ", "T"))
        return dt.replace(tzinfo=UAE_TZ).isoformat()
    except ValueError:
        pass

    text_padded = text
    if '.' in text:
        # pad to 6 decimal places for %f
        parts = text.split('.')
        parts[1] = parts[1].ljust(6, '0')
        text_padded = '.'.join(parts)

    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            dt = datetime.strptime(text_padded if "%f" in fmt else text, fmt)
            return dt.replace(tzinfo=UAE_TZ).isoformat()
        except ValueError:
            continue
    return None


def _convert_value(value: str) -> Optional[float]:
    text = (value or "").strip()
    if not text:
        return None
    text = re.sub(r'[a-zA-Z]', '', text).strip()
    try:
        return float(text)
    except ValueError:
        return None


def iter_rows_from_bytes(file_bytes: bytes) -> Iterable[Dict[str, str]]:
    decoded = file_bytes.decode("latin-1", errors="ignore").splitlines()
    header: Optional[List[str]] = None
    data_lines = []

    # Pass 1: find header
    for line in decoded:
        if "Timestamp" in line:
            header = [h.strip() for h in line.rstrip("\n").split("\t")]
            if header:
                header[0] = header[0].lstrip("\ufeff")
            break

    if not header:
        return

    # Pass 2: read data
    in_data = False
    for line in decoded:
        if "Timestamp" in line:
            in_data = True
            continue
        if not in_data or not line.strip():
            continue
        row = line.split("\t")
        if len(row) < len(header):
            row = row + [""] * (len(header) - len(row))
        yield dict(zip(header, row))


def build_message_samples(rows: Iterable[Dict[str, str]]) -> List[TelemetrySample]:
    samples = []
    for seq, row in enumerate(rows, start=1):
        ts_raw = row.get("Timestamp") or ""
        ts = _parse_timestamp(ts_raw)
        if not ts:
            continue
        signals = {}
        for key, value in row.items():
            key_name = (key or "").strip()
            if not key_name or key_name == "Timestamp" or key_name.lower() == "status":
                continue
            numeric = _convert_value(value or "")
            if numeric is None:
                continue
            signals[key_name] = numeric

        if signals:
            samples.append(TelemetrySample(ts=ts, seq=seq, signals=signals))
    return samples


def simple_feature_extract(file_bytes: bytes) -> dict:
    """
    Stub parser. Replace later with real NORMARC parsing + feature extraction.
    """
    size = len(file_bytes)
    decoded = file_bytes.decode("latin-1", errors="ignore")
    lines = decoded.count("\n") + 1 if decoded else 0
    alarm_hits = decoded.lower().count("alarm")

    columns = 0
    for line in decoded.splitlines():
        if "Timestamp" in line:
            columns = len(line.split("\t"))
            break

    anomaly_rate = min(1.0, (2 * alarm_hits) / max(1, lines))
    return {
        "bytes": size,
        "lines": lines,
        "alarm_hits": alarm_hits,
        "anomaly_rate": anomaly_rate,
        "columns": columns,
    }


def user_to_response(user) -> dict:
    from . import schemas
    return schemas.UserResponse(
        id=user.id,
        name=user.name,
        email=user.email,
        role=user.role,
        department=user.department,
        isActive=user.is_active,
        createdAt=to_uae_iso(user.created_at),
        lastLoginAt=to_uae_iso(user.last_login_at),
    )


def log_audit(db, actor, action: str, details: dict | None = None) -> None:
    from . import models
    log = models.AuditLog(
        actor_user_id=actor.id if actor else None,
        action=action,
        details=details or {},
    )
    db.add(log)
