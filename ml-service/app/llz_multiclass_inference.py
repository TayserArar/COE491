"""
ml-service/app/llz_multiclass_inference.py
-------------------------------------------
PyTorch Transformer-based multiclass classifier for LLZ subsystem.

Architecture reverse-engineered from best_model_filtered.pt checkpoint:
  proj:       Linear(F, d_model)             — input projection
  pos:        buffer [1, max_len, d_model]    — positional encoding
  enc:        TransformerEncoder(1 layer)     — self-attention + FFN
  head_fault: Linear(d) -> ReLU -> Linear(d, C)  — C-class fault classifier
  head_deg:   Linear(d) -> ReLU -> Linear(16, 1) — degradation head (ignored)

Only head_fault is used for inference.

Loads four notebook artifacts:
  - best_model_filtered.pt        (model weights)
  - training_artifacts.json       (feature_columns, label_map_filtered)
  - scaler.joblib                 (fitted sklearn scaler)
  - feature_transform.joblib      (optional sklearn transform)

Returns NORMAL for the healthy class, FAULT with the exact class name otherwise.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Model architecture  (matches notebook checkpoint exactly)
# ---------------------------------------------------------------------------

class _PositionalEncoding(nn.Module):
    """Learned positional encoding stored in a non-parameter buffer."""

    def __init__(self, d_model: int, max_len: int = 4096) -> None:
        super().__init__()
        # Register as persistent buffer so load_state_dict works with strict=True
        self.register_buffer("pe", torch.zeros(1, max_len, d_model))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        T = x.size(1)
        return x + self.pe[:, :T, :]


class LLZTransformerClassifier(nn.Module):
    """Transformer encoder with two heads:
      head_fault  — multiclass fault classifier  (used for inference)
      head_deg    — degradation scalar regressor  (ignored at inference)

    Architecture inferred from state-dict shapes:
      proj:             Linear(input_size, d_model)
      pos.pe:           [1, 4096, d_model]
      enc.layers.*:     TransformerEncoderLayer
      head_fault.0/3:   Linear(d_model, d_model) / Linear(d_model, num_classes)
      head_deg.0/2:     Linear(d_model, 16) / Linear(16, 1)
    """

    def __init__(
        self,
        input_size: int,
        d_model: int = 64,
        nhead: int = 3,
        num_encoder_layers: int = 1,
        dim_feedforward: int = 256,
        dropout: float = 0.1,
        num_classes: int = 34,
        max_len: int = 4096,
    ) -> None:
        super().__init__()
        self.proj = nn.Linear(input_size, d_model)
        self.pos = _PositionalEncoding(d_model, max_len)
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=nhead,
            dim_feedforward=dim_feedforward,
            dropout=dropout,
            batch_first=True,
        )
        self.enc = nn.TransformerEncoder(encoder_layer, num_layers=num_encoder_layers)
        # fault classification head: matches head_fault.0 / head_fault.3 in state_dict
        # (indices 0 and 3 suggest: Linear, ReLU, Dropout, Linear)
        self.head_fault = nn.Sequential(
            nn.Linear(d_model, d_model),
            nn.ReLU(),
            nn.Dropout(p=dropout),
            nn.Linear(d_model, num_classes),
        )
        # degradation regression head (not used for classification)
        self.head_deg = nn.Sequential(
            nn.Linear(d_model, 16),
            nn.ReLU(),
            nn.Linear(16, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """x: [B, T, F] → logits: [B, num_classes]"""
        z = self.proj(x)             # [B, T, d_model]
        z = self.pos(z)              # add positional encoding
        z = self.enc(z)              # transformer encoder
        # Mean-pool over time to get a fixed-size representation
        pooled = z.mean(dim=1)       # [B, d_model]
        return self.head_fault(pooled)   # [B, num_classes]


# ---------------------------------------------------------------------------
# Bundle dataclass
# ---------------------------------------------------------------------------


@dataclass
class LLZMulticlassBundle:
    version: str
    model: nn.Module
    feature_columns: List[str]
    label_map: Dict[int, str]
    normal_indices: List[int]
    window_rows: int
    scaler: Any
    feature_transform: Optional[Any]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _is_normal_label(label: str) -> bool:
    norm = label.strip().lower()
    return any(tok in norm for tok in ("normal", "healthy", "nominal", "no fault", "nofault"))


def _cfg_int(d: Dict[str, Any], keys: List[str], default: int) -> int:
    for k in keys:
        if k in d:
            try:
                return int(d[k])
            except (TypeError, ValueError):
                pass
    return default


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------


def load_llz_multiclass_bundle(
    model_path: str | Path,
    artifacts_path: str | Path,
    scaler_path: str | Path,
    ft_path: Optional[str | Path] = None,
) -> Optional[LLZMulticlassBundle]:
    """Load all notebook artifacts into an LLZMulticlassBundle.

    Returns None (with a warning) if any required file is missing or load fails.
    """
    model_file = Path(model_path)
    artifacts_file = Path(artifacts_path)
    scaler_file = Path(scaler_path)

    for p, name in [
        (model_file, "model_pt"),
        (artifacts_file, "artifacts_json"),
        (scaler_file, "scaler_joblib"),
    ]:
        if not p.exists():
            logger.warning("LLZ multiclass bundle: required file missing: %s (%s)", p, name)
            return None

    try:
        # ── 1. Training artifacts JSON ────────────────────────────────────────
        artifacts: Dict[str, Any] = json.loads(artifacts_file.read_text(encoding="utf-8"))

        feature_columns: List[str] = [str(c) for c in artifacts.get("feature_columns", [])]
        if not feature_columns:
            logger.warning("LLZ multiclass bundle: 'feature_columns' missing from %s", artifacts_file)
            return None

        raw_lm = (
            artifacts.get("label_map_filtered")
            or artifacts.get("label_map")
            or {}
        )
        label_map: Dict[int, str] = {int(k): str(v) for k, v in raw_lm.items()}
        if not label_map:
            logger.warning("LLZ multiclass bundle: 'label_map_filtered' missing from %s", artifacts_file)
            return None

        window_rows = _cfg_int(
            artifacts,
            ["window_rows", "window_size", "seq_len", "timesteps", "sequence_length"],
            300,
        )

        # ── 2. Scaler ─────────────────────────────────────────────────────────
        import joblib as _joblib  # noqa: PLC0415

        scaler = _joblib.load(scaler_file)

        # ── 3. Optional feature_transform ─────────────────────────────────────
        feature_transform: Optional[Any] = None
        if ft_path:
            ft_file = Path(ft_path)
            if ft_file.exists():
                try:
                    feature_transform = _joblib.load(ft_file)
                    logger.info("LLZ multiclass: loaded feature_transform from %s", ft_file)
                except Exception as exc:
                    logger.warning("LLZ multiclass: could not load feature_transform: %s", exc)

        # ── 4. Model checkpoint ───────────────────────────────────────────────
        ckpt = torch.load(model_file, map_location="cpu", weights_only=True)
        # Checkpoint is a raw OrderedDict (state_dict directly)
        state_dict: Dict[str, Any] = dict(ckpt)

        # Strip DDP prefix if present
        state_dict = {(k[7:] if k.startswith("module.") else k): v for k, v in state_dict.items()}

        # ── Infer architecture from state-dict shapes ─────────────────────────
        # proj.weight: [d_model, input_size]
        d_model = state_dict["proj.weight"].shape[0]
        input_size = state_dict["proj.weight"].shape[1]

        # pe buffer: [1, max_len, d_model]
        max_len = state_dict["pos.pe"].shape[1]

        # nhead: prefer training_artifacts best_trial_params (most reliable source)
        # in_proj_weight is [3*d_model, d_model] in PyTorch MHA — does NOT encode nhead
        trial_params = artifacts.get("best_trial_params") or {}
        nhead_raw = (
            trial_params.get("nhead")
            or trial_params.get("num_heads")
            or trial_params.get("n_heads")
        )
        if nhead_raw is not None:
            nhead = int(nhead_raw)
        else:
            # Fall back: find the largest valid divisor of d_model from common values
            for candidate in (8, 4, 2, 1):
                if d_model % candidate == 0:
                    nhead = candidate
                    break
            else:
                nhead = 1
        logger.info("LLZ model: d_model=%d nhead=%d (from %s)",
                    d_model, nhead, "best_trial_params" if nhead_raw is not None else "fallback")

        # dim_feedforward: enc.layers.0.linear1.weight [ff, d_model]
        dim_feedforward = state_dict["enc.layers.0.linear1.weight"].shape[0]

        # num_encoder_layers: count distinct layer indices
        layer_indices = set()
        for k in state_dict:
            if k.startswith("enc.layers."):
                idx = k.split(".")[2]
                layer_indices.add(idx)
        num_encoder_layers = len(layer_indices) or 1

        # num_classes: head_fault.3.weight [num_classes, d_model]
        num_classes = state_dict["head_fault.3.weight"].shape[0]

        # dropout: prefer trial_params
        dropout = float(trial_params.get("dropout") or 0.1)

        logger.info(
            "LLZ Transformer arch: input=%d d_model=%d nhead=%d ff=%d layers=%d classes=%d",
            input_size, d_model, nhead, dim_feedforward, num_encoder_layers, num_classes,
        )

        model = LLZTransformerClassifier(
            input_size=input_size,
            d_model=d_model,
            nhead=nhead,
            num_encoder_layers=num_encoder_layers,
            dim_feedforward=dim_feedforward,
            num_classes=num_classes,
            max_len=max_len,
        )
        missing, unexpected = model.load_state_dict(state_dict, strict=False)
        # head_deg keys may not be present in strict form; log but continue
        if unexpected:
            logger.warning("LLZ model: unexpected keys in checkpoint: %s", unexpected)
        if missing:
            logger.warning("LLZ model: missing keys in checkpoint: %s", missing)
        model.to("cpu").eval()

        normal_indices = [idx for idx, lbl in label_map.items() if _is_normal_label(lbl)]
        version = model_file.name

        bundle = LLZMulticlassBundle(
            version=version,
            model=model,
            feature_columns=feature_columns,
            label_map=label_map,
            normal_indices=normal_indices,
            window_rows=window_rows,
            scaler=scaler,
            feature_transform=feature_transform,
        )
        logger.info(
            "LLZ multiclass bundle loaded OK: %d classes, %d features, T=%d, normal_idx=%s",
            num_classes, len(feature_columns), window_rows, normal_indices,
        )
        return bundle

    except Exception as exc:
        logger.warning("Failed to load LLZ multiclass bundle: %s", exc, exc_info=True)
        return None


# ---------------------------------------------------------------------------
# Preprocessing
# ---------------------------------------------------------------------------


def _window_to_matrix(window: Any) -> Tuple[List[str], np.ndarray]:
    """Convert WindowData → (col_names, matrix[T, F]).

    Sorts by timestamp, deduplicates, forward+backward-fills NaNs.
    """
    from datetime import datetime  # noqa: PLC0415

    def _parse_ts(v: str) -> Optional[Any]:
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None

    samples = getattr(window, "samples", None) or []
    if not samples:
        return [], np.empty((0, 0), dtype=np.float32)

    parsed = []
    for s in samples:
        dt = _parse_ts(s.ts)
        if dt is not None:
            parsed.append((dt, s))
    if not parsed:
        return [], np.empty((0, 0), dtype=np.float32)
    parsed.sort(key=lambda x: x[0])

    # Collect column names in first-occurrence order
    col_set: Dict[str, int] = {}
    for _, s in parsed:
        for col in (s.signals or {}):
            if col not in col_set:
                col_set[col] = len(col_set)
    col_names = list(col_set)
    if not col_names:
        return [], np.empty((0, 0), dtype=np.float32)

    # Build raw matrix
    mat = np.full((len(parsed), len(col_names)), np.nan, dtype=np.float32)
    for i, (_, s) in enumerate(parsed):
        for col, val in (s.signals or {}).items():
            if col in col_set and isinstance(val, (int, float)) and not math.isnan(val):
                mat[i, col_set[col]] = float(val)

    # Deduplicate timestamps (keep first)
    t0 = parsed[0][0]
    times = np.array([(dt - t0).total_seconds() for dt, _ in parsed], dtype=np.float32)
    _, uniq_idx = np.unique(times, return_index=True)
    mat = mat[uniq_idx]

    # Forward-fill then backward-fill NaNs per column
    for j in range(mat.shape[1]):
        col = mat[:, j]
        for i in range(1, len(col)):
            if np.isnan(col[i]) and not np.isnan(col[i - 1]):
                col[i] = col[i - 1]
        for i in range(len(col) - 2, -1, -1):
            if np.isnan(col[i]) and not np.isnan(col[i + 1]):
                col[i] = col[i + 1]
        col[np.isnan(col)] = 0.0
        mat[:, j] = col

    return col_names, mat


def _preprocess_window(window: Any, bundle: LLZMulticlassBundle) -> Optional[np.ndarray]:
    """Notebook preprocessing pipeline → float32 [T, F] ready for scaler."""
    col_names, mat = _window_to_matrix(window)
    if mat.shape[0] == 0:
        return None

    col_names_stripped = [c.strip() for c in col_names]
    col_index = {c: i for i, c in enumerate(col_names_stripped)}

    T_raw = mat.shape[0]
    F = len(bundle.feature_columns)
    aligned = np.zeros((T_raw, F), dtype=np.float32)
    for j, feat in enumerate(bundle.feature_columns):
        src_j = col_index.get(feat.strip())
        if src_j is not None:
            aligned[:, j] = mat[:, src_j]

    # Resample to window_rows
    target_T = bundle.window_rows
    if T_raw != target_T:
        if T_raw < 2:
            if T_raw < target_T:
                pad = np.zeros((target_T - T_raw, F), dtype=np.float32)
                aligned = np.vstack([aligned, pad])
            else:
                aligned = aligned[:target_T]
        else:
            src_t = np.linspace(0.0, 1.0, T_raw, dtype=np.float32)
            dst_t = np.linspace(0.0, 1.0, target_T, dtype=np.float32)
            resampled = np.empty((target_T, F), dtype=np.float32)
            for j in range(F):
                resampled[:, j] = np.interp(dst_t, src_t, aligned[:, j]).astype(np.float32)
            aligned = resampled

    return aligned.astype(np.float32)


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------


def predict_llz_multiclass(
    bundle: LLZMulticlassBundle,
    window: Any,
) -> Optional[Dict[str, Any]]:
    """Run the Transformer multiclass classifier on a single window."""
    mat = _preprocess_window(window, bundle)
    if mat is None:
        return None

    try:
        mat_scaled = bundle.scaler.transform(mat).astype(np.float32)
    except Exception as exc:
        logger.warning("LLZ scaler.transform failed: %s", exc)
        return None

    if bundle.feature_transform is not None:
        try:
            if isinstance(bundle.feature_transform, np.ndarray):
                # Numpy index array — select columns
                mat_scaled = mat_scaled[:, bundle.feature_transform].astype(np.float32)
            else:
                mat_scaled = bundle.feature_transform.transform(mat_scaled).astype(np.float32)
        except Exception as exc:
            logger.warning("LLZ feature_transform failed (skipping): %s", exc)

    x = torch.from_numpy(mat_scaled).unsqueeze(0)  # [1, T, F]

    with torch.no_grad():
        logits = bundle.model(x)                   # [1, num_classes]
        probs = torch.softmax(logits, dim=-1)[0]   # [num_classes]

    label_idx = int(torch.argmax(probs).item())
    confidence = float(probs[label_idx].item())
    label = bundle.label_map.get(label_idx, f"class_{label_idx}")

    is_normal = label_idx in bundle.normal_indices
    prediction = "NORMAL" if is_normal else "FAULT"
    fault_type = None if is_normal else label

    issues: List[Dict[str, Any]] = []
    if not is_normal:
        issues.append(
            {
                "type": label,
                "severity": "high",
                "description": f"LLZ multiclass detected: {label} (confidence {confidence:.2%}).",
                "recommendation": "Inspect LLZ subsystem signal patterns and validate with maintenance procedures.",
            }
        )

    return {
        "prediction": prediction,
        "confidence": float(max(0.0, min(1.0, confidence))),
        "anomaly_rate": 0.0 if is_normal else float(max(0.0, min(1.0, 1.0 - confidence))),
        "fault_type": fault_type,
        "issues": issues,
        "model_version": bundle.version,
    }
