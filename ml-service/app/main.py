from dataclasses import dataclass
from datetime import datetime
import json
import logging
import time
import math
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from fastapi import FastAPI
import numpy as np
from pydantic import BaseModel
from shared.schemas import TelemetrySample, WindowData  # noqa: F401
from tensorflow import keras
from .healthy_inference import (
    HealthyBundle,
    load_healthy_bundle,
    score_window_ae,
    top_k_signals,
)

app = FastAPI(title="ML Service", version="0.1")
UAE_TZ = ZoneInfo("Asia/Dubai")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("ml-service")

class PredictRequest(BaseModel):
    subsystem: str
    features: Optional[Dict[str, Any]] = None
    window: Optional[WindowData] = None
    metadata: Dict[str, Any] = {}


@dataclass
class ModelBundle:
    subsystem: str
    version: str
    model: Any
    labels: List[str]
    input_shape: Tuple[Any, ...]
    feature_order: Optional[List[str]] = None
    norm_mean: Optional[np.ndarray] = None
    norm_std: Optional[np.ndarray] = None


MODEL_BUNDLES: Dict[str, ModelBundle] = {}
HEALTHY_BUNDLES: Dict[str, HealthyBundle] = {}


def _normalize_subsystem(value: str) -> str:
    return (value or "").strip().upper()


def _choose_existing_path(primary: str, *fallbacks: str) -> str:
    for candidate in (primary, *fallbacks):
        if candidate and Path(candidate).exists():
            return candidate
    return primary


def _load_labels(path: Path) -> List[str]:
    """Load labels robustly across numpy versions.

    Preferred: JSON list (portable).
    Supported: NPY object array (may reference numpy._core.* during unpickle).
    """
    if path.suffix.lower() == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            raise ValueError(f"Label JSON must be a list: {path}")
        return [str(x) for x in data]

    try:
        labels = np.load(path, allow_pickle=True)
        return [str(label) for label in labels.tolist()]
    except ModuleNotFoundError:
        import sys
        import numpy.core as _np_core
        sys.modules.setdefault("numpy._core", _np_core)
        sys.modules.setdefault("numpy._core.multiarray", _np_core.multiarray)
        labels = np.load(path, allow_pickle=True)
        return [str(label) for label in labels.tolist()]


def _load_feature_order(path: Path) -> Optional[List[str]]:
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"Feature order JSON must be a list: {path}")
    return [str(x) for x in data]


def _load_norm(mean_path: Path, std_path: Path) -> Tuple[Optional[np.ndarray], Optional[np.ndarray]]:
    if not mean_path.exists() or not std_path.exists():
        return None, None
    mean = np.load(mean_path).astype(np.float32)
    std = np.load(std_path).astype(np.float32)
    return mean, std


def _load_bundle(
    subsystem: str,
    model_path: str,
    labels_path: str,
    features_path: Optional[str] = None,
    norm_mean_path: Optional[str] = None,
    norm_std_path: Optional[str] = None,
) -> Optional[ModelBundle]:
    model_file = Path(model_path)
    labels_file = Path(labels_path)
    if not model_file.exists() or not labels_file.exists():
        return None

    model = keras.models.load_model(model_file)
    labels = _load_labels(labels_file)
    input_shape = tuple(model.input_shape) if isinstance(model.input_shape, tuple) else tuple(model.input_shape[0])

    feature_order = _load_feature_order(Path(features_path)) if features_path else None
    norm_mean, norm_std = (None, None)
    if norm_mean_path and norm_std_path:
        norm_mean, norm_std = _load_norm(Path(norm_mean_path), Path(norm_std_path))

    return ModelBundle(
        subsystem=subsystem,
        version=model_file.name,
        model=model,
        labels=labels,
        input_shape=input_shape,
        feature_order=feature_order,
        norm_mean=norm_mean,
        norm_std=norm_std,
    )


@app.on_event("startup")
def startup_load_models() -> None:
    gp_model = os.getenv("MODEL_GP_PATH", "/app/models/lstm_gp.keras")
    gp_labels = os.getenv("MODEL_GP_LABELS_PATH", "/app/models/lstm_gp_labels.npy")
    gp_features = os.getenv("MODEL_GP_FEATURES_PATH", "/app/models/lstm_gp_features.json")
    gp_mean = os.getenv("MODEL_GP_NORM_MEAN_PATH", "")
    gp_std = os.getenv("MODEL_GP_NORM_STD_PATH", "")
    llz_model = os.getenv("MODEL_LLZ_PATH", "/app/models/lstm_llz.keras")
    llz_labels = os.getenv("MODEL_LLZ_LABELS_PATH", "/app/models/lstm_llz_labels.npy")
    llz_features = os.getenv("MODEL_LLZ_FEATURES_PATH", "/app/models/lstm_llz_features.json")
    llz_mean = os.getenv("MODEL_LLZ_NORM_MEAN_PATH", "")
    llz_std = os.getenv("MODEL_LLZ_NORM_STD_PATH", "")

    gp_bundle = _load_bundle(
        "GP",
        gp_model,
        gp_labels,
        features_path=gp_features,
        norm_mean_path=gp_mean or None,
        norm_std_path=gp_std or None,
    )
    if gp_bundle:
        MODEL_BUNDLES["GP"] = gp_bundle

    llz_bundle = _load_bundle(
        "LLZ",
        llz_model,
        llz_labels,
        features_path=llz_features,
        norm_mean_path=llz_mean or None,
        norm_std_path=llz_std or None,
    )
    if llz_bundle:
        MODEL_BUNDLES["LLZ"] = llz_bundle

    gp_ae = _choose_existing_path(
        os.getenv("HEALTHY_GP_AE_PATH", "/app/models/healthy/gp_ae.pt"),
        "/app/models/healthy/gp_lstm_ae.pt",
    )
    gp_fc = _choose_existing_path(
        os.getenv("HEALTHY_GP_FC_PATH", "/app/models/healthy/gp_fc.pt"),
        "/app/models/healthy/gp_lstm_fc.pt",
    )
    gp_scaler = os.getenv("HEALTHY_GP_SCALER_PATH", "/app/models/healthy/gp_scaler.npz")
    gp_thr = os.getenv("HEALTHY_GP_THRESHOLDS_PATH", "/app/models/healthy/gp_thresholds.json")
    llz_ae = _choose_existing_path(
        os.getenv("HEALTHY_LLZ_AE_PATH", "/app/models/healthy/llz_ae.pt"),
        "/app/models/healthy/llz_lstm_ae.pt",
    )
    llz_fc = _choose_existing_path(
        os.getenv("HEALTHY_LLZ_FC_PATH", "/app/models/healthy/llz_fc.pt"),
        "/app/models/healthy/llz_lstm_fc.pt",
    )
    llz_scaler = os.getenv("HEALTHY_LLZ_SCALER_PATH", "/app/models/healthy/llz_scaler.npz")
    llz_thr = os.getenv("HEALTHY_LLZ_THRESHOLDS_PATH", "/app/models/healthy/llz_thresholds.json")

    gp_healthy = load_healthy_bundle("GP", gp_ae, gp_fc, gp_scaler, gp_thr)
    if gp_healthy:
        HEALTHY_BUNDLES["GP"] = gp_healthy

    llz_healthy = load_healthy_bundle("LLZ", llz_ae, llz_fc, llz_scaler, llz_thr)
    if llz_healthy:
        HEALTHY_BUNDLES["LLZ"] = llz_healthy

@app.get("/health")
def health():
    models = {}
    for key, bundle in MODEL_BUNDLES.items():
        t, f = _expected_dims(bundle)
        models[key] = {
            "version": bundle.version,
            "timesteps": t,
            "features": f,
            "has_feature_order": bool(bundle.feature_order),
            "has_norm": bool(bundle.norm_mean is not None and bundle.norm_std is not None),
            "num_labels": len(bundle.labels),
        }
    healthy_models = {}
    for key, bundle in HEALTHY_BUNDLES.items():
        healthy_models[key] = {
            "version": bundle.version,
            "window_rows": bundle.window_rows,
            "num_signals": len(bundle.signal_cols),
            "ae_threshold": bundle.ae_threshold,
            "fc_threshold": bundle.fc_threshold,
            "has_scaler": True,
        }
    return {"status": "ok", "models": models, "healthy_models": healthy_models}


def _parse_ts(value: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _extract_window_features(window: WindowData) -> Dict[str, Any]:
    samples = window.samples or []
    signal_values: Dict[str, List[float]] = {}

    for sample in samples:
        for name, value in (sample.signals or {}).items():
            if isinstance(value, (int, float)) and not math.isnan(value):
                signal_values.setdefault(name, []).append(float(value))

    signal_stats = {}
    for name, values in signal_values.items():
        if not values:
            continue
        mean = sum(values) / len(values)
        variance = sum((v - mean) ** 2 for v in values) / max(1, len(values) - 1)
        std = math.sqrt(variance)
        min_val = min(values)
        max_val = max(values)
        signal_stats[name] = {
            "mean": mean,
            "std": std,
            "min": min_val,
            "max": max_val,
            "range": max_val - min_val,
        }

    start_dt = _parse_ts(window.start_ts)
    end_dt = _parse_ts(window.end_ts)
    duration_sec = None
    if start_dt and end_dt:
        duration_sec = max(0.0, (end_dt - start_dt).total_seconds())

    return {
        "sample_count": len(samples),
        "signal_count": len(signal_values),
        "signal_stats": signal_stats,
        "window_duration_sec": duration_sec,
    }


def _score_window(features: Dict[str, Any]) -> Dict[str, Any]:
    stats = features.get("signal_stats", {}) or {}
    best_signal = None
    best_range_ratio = 0.0
    best_std_ratio = 0.0

    for name, info in stats.items():
        mean = float(info.get("mean", 0.0))
        std = float(info.get("std", 0.0))
        value_range = float(info.get("range", 0.0))
        denom = abs(mean) + 1e-6
        range_ratio = value_range / denom
        std_ratio = std / denom
        if range_ratio > best_range_ratio:
            best_range_ratio = range_ratio
            best_std_ratio = std_ratio
            best_signal = name

    fault_score = max(best_range_ratio, best_std_ratio)
    anomaly_rate = min(1.0, fault_score / 3.0) if fault_score > 0 else 0.0

    fault_type = None
    if fault_score >= 2.5:
        if best_range_ratio >= 2.5 and best_std_ratio < 1.0:
            fault_type = "signal_spike"
        elif best_std_ratio >= 1.5:
            fault_type = "signal_noise"
        else:
            fault_type = "signal_drift"

    return {
        "fault_score": fault_score,
        "anomaly_rate": anomaly_rate,
        "fault_type": fault_type,
        "fault_signal": best_signal,
    }


def _expected_dims(bundle: ModelBundle) -> Tuple[Optional[int], Optional[int]]:
    shape = bundle.input_shape
    if len(shape) < 3:
        return None, None
    timesteps = shape[1] if isinstance(shape[1], int) else None
    features = shape[2] if isinstance(shape[2], int) else None
    return timesteps, features


def _window_to_matrix(
    window: WindowData,
    signal_names: List[str],
    target_steps: Optional[int],
    target_features: Optional[int] = None,
    norm_mean: Optional[np.ndarray] = None,
    norm_std: Optional[np.ndarray] = None,
) -> Optional[np.ndarray]:
    """Unified preprocessing pipeline shared by both LSTM and healthy-model paths.

    1. Parse and sort samples by timestamp.
    2. Deduplicate rows with identical timestamps.
    3. Build a (N, F) signal matrix; forward-fill NaN values per feature.
    4. Crop / pad the feature axis to *target_features* (optional).
    5. Resample to *target_steps* rows using timestamp-aware linear interpolation.
    6. Optionally z-score normalise with the supplied mean/std.

    Returns a float32 (T, F) numpy array, or None on failure.
    """
    samples = window.samples or []
    if not samples or not signal_names:
        return None

    # Step 1 — parse & sort by timestamp
    parsed: List[Tuple[datetime, TelemetrySample]] = []
    for s in samples:
        dt = _parse_ts(s.ts)
        if dt is not None:
            parsed.append((dt, s))
    if not parsed:
        return None
    parsed.sort(key=lambda x: x[0])
    dts = [p[0] for p in parsed]
    samples_sorted = [p[1] for p in parsed]

    # Step 2 — deduplicate identical timestamps
    t0 = dts[0]
    times = np.array([(dt - t0).total_seconds() for dt in dts], dtype=np.float32)
    uniq_times, uniq_idx = np.unique(times, return_index=True)
    samples_sorted = [samples_sorted[i] for i in uniq_idx.tolist()]
    times = uniq_times

    # Step 3 — build signal matrix & forward-fill NaNs
    matrix = np.full((len(samples_sorted), len(signal_names)), np.nan, dtype=np.float32)
    for i, sample in enumerate(samples_sorted):
        sig = sample.signals or {}
        for j, name in enumerate(signal_names):
            value = sig.get(name)
            if isinstance(value, (int, float)) and not math.isnan(value):
                matrix[i, j] = float(value)

    for j in range(matrix.shape[1]):
        col = matrix[:, j]
        valid = np.isfinite(col)
        if not valid.any():
            col[:] = 0.0
        else:
            first = int(np.argmax(valid))
            col[:first] = col[first]
            for i in range(first + 1, len(col)):
                if not np.isfinite(col[i]):
                    col[i] = col[i - 1]
        matrix[:, j] = col

    # Step 4 — align feature axis (optional)
    if target_features is not None:
        if matrix.shape[1] > target_features:
            matrix = matrix[:, :target_features]
        elif matrix.shape[1] < target_features:
            pad = np.zeros((matrix.shape[0], target_features - matrix.shape[1]), dtype=np.float32)
            matrix = np.hstack((matrix, pad))

    # Step 5 — resample to target_steps
    if target_steps is not None and target_steps > 0:
        if len(times) < 2:
            current_steps = matrix.shape[0]
            if current_steps > target_steps:
                matrix = matrix[-target_steps:, :]
            elif current_steps < target_steps:
                pad = np.zeros((target_steps - current_steps, matrix.shape[1]), dtype=np.float32)
                matrix = np.vstack((pad, matrix))
        else:
            duration = float(times[-1] - times[0])
            duration = duration if duration > 0 else 1.0
            grid = np.linspace(0.0, duration, target_steps, dtype=np.float32)
            resampled = np.empty((target_steps, matrix.shape[1]), dtype=np.float32)
            base_times = times - times[0]
            for j in range(matrix.shape[1]):
                resampled[:, j] = np.interp(grid, base_times, matrix[:, j]).astype(np.float32)
            matrix = resampled

    # Step 6 — optional z-score normalisation
    if norm_mean is not None and norm_std is not None:
        if norm_mean.shape[0] == matrix.shape[1] and norm_std.shape[0] == matrix.shape[1]:
            matrix = (matrix - norm_mean[None, :]) / (norm_std[None, :] + 1e-6)

    return matrix.astype(np.float32)


def _window_to_tensor(window: WindowData, bundle: ModelBundle) -> Optional[np.ndarray]:
    """Preprocess a telemetry window for the Keras LSTM model.

    Returns a float32 (1, T, F) tensor ready for model.predict(), or None.
    """
    if not (window.samples):
        return None

    if bundle.feature_order:
        signal_names = bundle.feature_order
    else:
        signal_names = sorted({key for s in (window.samples or []) for key in (s.signals or {}).keys()})
    if not signal_names:
        return None

    target_steps, target_features = _expected_dims(bundle)
    matrix = _window_to_matrix(
        window,
        signal_names=signal_names,
        target_steps=target_steps,
        target_features=target_features,
        norm_mean=bundle.norm_mean,
        norm_std=bundle.norm_std,
    )
    if matrix is None:
        return None
    return np.expand_dims(matrix, axis=0)  # (1, T, F)


def _window_to_matrix_for_healthy(
    window: WindowData, signal_cols: List[str], target_steps: int
) -> Optional[np.ndarray]:
    """Preprocess a telemetry window for the PyTorch healthy-model path.

    Caller is responsible for z-score normalisation after this call.
    Returns a float32 (T, F) matrix, or None.
    """
    steps = target_steps if target_steps > 0 else None
    return _window_to_matrix(window, signal_names=signal_cols, target_steps=steps)


def _predict_with_healthy(bundle: HealthyBundle, window: Optional[WindowData]) -> Optional[Dict[str, Any]]:
    if window is None:
        return None

    target_steps = int(bundle.window_rows or 300)
    matrix = _window_to_matrix_for_healthy(window, bundle.signal_cols, target_steps)
    if matrix is None:
        return None

    x_scaled = (matrix - bundle.mean[None, :]) / (bundle.std[None, :] + 1e-6)
    ae_score, ae_pf = score_window_ae(bundle, x_scaled)
    ae_ratio = float(ae_score / (bundle.ae_threshold + 1e-12))
    ratio = ae_ratio
    anomaly_rate = float(min(1.0, ratio))

    is_fault = ae_score > bundle.ae_threshold

    fault_type = None
    if is_fault:
        fault_type = "AE_RECON"
    top_signals = top_k_signals(ae_pf, bundle.signal_cols, k=3)

    issues: List[Dict[str, Any]] = []
    if is_fault:
        issues.append(
            {
                "type": fault_type,
                "severity": "high" if ratio >= 1.25 else "medium",
                "description": (
                    f"AE {ae_score:.6f}/{bundle.ae_threshold:.6f}; "
                    f"top signals: {', '.join(top_signals) if top_signals else 'n/a'}."
                ),
                "recommendation": "Inspect highlighted signals and validate subsystem behavior.",
            }
        )

    return {
        "prediction": "FAULT" if is_fault else "NORMAL",
        "confidence": float(min(1.0, ratio)) if is_fault else float(1.0 - min(1.0, ratio)),
        "anomaly_rate": anomaly_rate,
        "fault_type": fault_type,
        "issues": issues,
        "model_version": bundle.version,
        "metrics": {
            "ae_score": float(ae_score),
            "ae_threshold": float(bundle.ae_threshold),
            "ae_ratio": float(ae_ratio),
            "fc_score": None,
            "fc_threshold": None,
            "fc_ratio": None,
            "top_signals": top_signals,
            "dominant": "AE",
            "fc_enabled": False,
        },
    }


def _is_normal_label(label: str) -> bool:
    normalized = label.strip().lower()
    return any(token in normalized for token in ("normal", "healthy", "nominal"))


def _predict_with_bundle(bundle: ModelBundle, window: Optional[WindowData]) -> Optional[Dict[str, Any]]:
    if window is None:
        return None

    x = _window_to_tensor(window, bundle)
    if x is None:
        return None

    raw = bundle.model.predict(x, verbose=0)
    prediction = np.asarray(raw)
    if prediction.ndim == 1:
        prediction = np.expand_dims(prediction, axis=0)

    threshold = float(os.getenv("MODEL_BINARY_THRESHOLD", "0.5"))
    label_idx = 0
    confidence = 0.5

    if prediction.shape[-1] == 1:
        score = float(prediction[0][0])
        label_idx = 1 if score >= threshold else 0
        confidence = score if label_idx == 1 else (1.0 - score)
        anomaly_rate = score
    else:
        probs = prediction[0].astype(float)
        label_idx = int(np.argmax(probs))
        confidence = float(probs[label_idx])
        anomaly_rate = 1.0 - confidence if _is_normal_label(bundle.labels[label_idx]) else confidence

    if label_idx >= len(bundle.labels):
        label = f"class_{label_idx}"
    else:
        label = bundle.labels[label_idx]

    is_normal = _is_normal_label(label)
    pred = "NORMAL" if is_normal else "FAULT"
    issues: List[Dict[str, Any]] = []
    fault_type = None if is_normal else label

    if not is_normal:
        issues.append(
            {
                "type": label,
                "severity": "high",
                "description": f"Detected {label} for subsystem {bundle.subsystem}.",
                "recommendation": "Inspect subsystem and validate fault with maintenance procedures.",
            }
        )

    return {
        "prediction": pred,
        "confidence": float(max(0.0, min(1.0, confidence))),
        "anomaly_rate": float(max(0.0, min(1.0, anomaly_rate))),
        "fault_type": fault_type,
        "issues": issues,
        "model_version": bundle.version,
    }


@app.post("/v1/predict")
def predict(req: PredictRequest):
    t0 = time.perf_counter()
    subsystem = _normalize_subsystem(req.subsystem)
    healthy_bundle = HEALTHY_BUNDLES.get(subsystem)
    if healthy_bundle and req.window is not None:
        healthy_result = _predict_with_healthy(healthy_bundle, req.window)
        if healthy_result is not None:
            elapsed = time.perf_counter() - t0
            logger.info("Inference for %s (healthy) took %.3f seconds", subsystem, elapsed)
            return healthy_result

    model_bundle = MODEL_BUNDLES.get(subsystem)
    model_result = _predict_with_bundle(model_bundle, req.window) if model_bundle else None
    if model_result is not None:
        elapsed = time.perf_counter() - t0
        logger.info("Inference for %s (lstm) took %.3f seconds", subsystem, elapsed)
        return model_result

    features = req.features or {}

    if req.window is not None:
        window_features = _extract_window_features(req.window)
        features = {**features, **window_features}

    scored = _score_window(features) if features.get("signal_stats") else None
    anomaly_rate = float(
        (scored or {}).get("anomaly_rate", features.get("anomaly_rate", 0.0))
    )

    pred = "NORMAL"
    confidence = 0.7
    issues: List[dict] = []

    if scored and scored.get("fault_type"):
        pred = "FAULT"
        confidence = min(0.95, 0.75 + (scored["fault_score"] / 10.0))
        fault_type = scored["fault_type"]
        fault_signal = scored.get("fault_signal") or "unknown"
        issues.append(
            {
                "type": fault_type,
                "severity": "high",
                "description": f"Detected {fault_type.replace('_', ' ')} on {fault_signal}.",
                "recommendation": "Inspect subsystem and review signal behavior in the 5-minute window.",
            }
        )

    result = {
        "prediction": pred,
        "confidence": confidence,
        "anomaly_rate": anomaly_rate,
        "fault_type": (scored or {}).get("fault_type") if pred == "FAULT" else None,
        "issues": issues,
        "model_version": "heuristic-fallback-0.3"
    }
    elapsed = time.perf_counter() - t0
    logger.info("Inference for %s took %.3f seconds", subsystem, elapsed)
    return result
