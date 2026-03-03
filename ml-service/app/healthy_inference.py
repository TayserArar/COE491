from dataclasses import dataclass
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn

logger = logging.getLogger(__name__)


class LSTMAutoencoder(nn.Module):
    def __init__(self, d_in: int, hidden: int = 128, num_layers: int = 2, dropout: float = 0.1) -> None:
        super().__init__()
        self.encoder = nn.LSTM(
            input_size=d_in,
            hidden_size=hidden,
            num_layers=num_layers,
            dropout=dropout if num_layers > 1 else 0.0,
            batch_first=True,
        )
        self.decoder = nn.LSTM(
            input_size=hidden,
            hidden_size=hidden,
            num_layers=1,
            batch_first=True,
        )
        self.out = nn.Linear(hidden, d_in)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        _, (h_n, _) = self.encoder(x)
        z = h_n[-1]
        z_rep = z.unsqueeze(1).repeat(1, x.size(1), 1)
        y, _ = self.decoder(z_rep)
        return self.out(y)


class LSTMOneStepForecaster(nn.Module):
    def __init__(self, d_in: int, hidden: int = 128, num_layers: int = 2, dropout: float = 0.1) -> None:
        super().__init__()
        self.lstm = nn.LSTM(
            input_size=d_in,
            hidden_size=hidden,
            num_layers=num_layers,
            dropout=dropout if num_layers > 1 else 0.0,
            batch_first=True,
        )
        self.out = nn.Linear(hidden, d_in)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y, _ = self.lstm(x)
        return self.out(y)


@dataclass
class HealthyBundle:
    subsystem: str
    version: str
    signal_cols: list[str]
    mean: np.ndarray
    std: np.ndarray
    ae_threshold: float
    fc_threshold: float
    window_rows: int
    ae_model: nn.Module
    fc_model: nn.Module


def _to_string_list(values: Any) -> List[str]:
    if values is None:
        return []
    if isinstance(values, np.ndarray):
        values = values.tolist()
    if not isinstance(values, list):
        return [str(values)]
    out: List[str] = []
    for item in values:
        if isinstance(item, bytes):
            out.append(item.decode("utf-8", errors="ignore"))
        else:
            out.append(str(item))
    return out


def load_scaler_npz(path: str | Path) -> Tuple[np.ndarray, np.ndarray, List[str]]:
    scaler_path = Path(path)
    with np.load(scaler_path, allow_pickle=True) as data:
        if "mean" in data and "std" in data:
            mean = data["mean"]
            std = data["std"]
        elif "mu" in data and "sigma" in data:
            mean = data["mu"]
            std = data["sigma"]
        elif "x_mean" in data and "x_std" in data:
            mean = data["x_mean"]
            std = data["x_std"]
        else:
            raise ValueError(f"Unsupported scaler keys in {scaler_path}")

        signal_cols = _to_string_list(data["signal_cols"]) if "signal_cols" in data else []

    mean = np.asarray(mean, dtype=np.float32).reshape(-1)
    std = np.asarray(std, dtype=np.float32).reshape(-1)
    if mean.shape[0] != std.shape[0]:
        raise ValueError(f"Scaler mean/std size mismatch in {scaler_path}")
    if not signal_cols:
        signal_cols = [f"signal_{i}" for i in range(mean.shape[0])]
    elif len(signal_cols) != mean.shape[0]:
        signal_cols = signal_cols[: mean.shape[0]]
        if len(signal_cols) < mean.shape[0]:
            signal_cols.extend([f"signal_{i}" for i in range(len(signal_cols), mean.shape[0])])
    return mean, std, signal_cols


def load_thresholds(path_json: str | Path) -> Tuple[float, float]:
    payload = json.loads(Path(path_json).read_text(encoding="utf-8"))
    return float(payload["ae_threshold"]), float(payload["fc_threshold"])


def load_torch_checkpoint(path_pt: str | Path) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    obj = torch.load(Path(path_pt), map_location="cpu")
    if isinstance(obj, dict) and "state_dict" in obj:
        state_dict = obj["state_dict"]
        config = obj.get("config", {}) or {}
    elif isinstance(obj, dict) and all(isinstance(k, str) for k in obj.keys()):
        state_dict = obj
        config = {}
    else:
        raise ValueError(f"Unsupported checkpoint format: {path_pt}")

    if not isinstance(state_dict, dict):
        raise ValueError(f"Invalid state_dict in checkpoint: {path_pt}")
    if not isinstance(config, dict):
        config = {}
    return state_dict, config


def _normalize_state_dict(state_dict: Dict[str, Any]) -> Dict[str, Any]:
    cleaned: Dict[str, Any] = {}
    for key, value in state_dict.items():
        new_key = key[7:] if key.startswith("module.") else key
        cleaned[new_key] = value
    return cleaned


def _config_int(config: Dict[str, Any], keys: List[str], default: int) -> int:
    for key in keys:
        if key in config:
            try:
                return int(config[key])
            except (TypeError, ValueError):
                continue
    return default


def _config_float(config: Dict[str, Any], keys: List[str], default: float) -> float:
    for key in keys:
        if key in config:
            try:
                return float(config[key])
            except (TypeError, ValueError):
                continue
    return default


def build_models(d_in: int, config: Dict[str, Any]) -> Tuple[nn.Module, nn.Module]:
    hidden = _config_int(config, ["hidden", "hidden_size"], 128)
    num_layers = _config_int(config, ["num_layers", "layers"], 2)
    dropout = _config_float(config, ["dropout"], 0.1)
    ae = LSTMAutoencoder(d_in=d_in, hidden=hidden, num_layers=num_layers, dropout=dropout)
    fc = LSTMOneStepForecaster(d_in=d_in, hidden=hidden, num_layers=num_layers, dropout=dropout)
    return ae, fc


def load_healthy_bundle(
    subsystem: str,
    ae_path: str | Path,
    fc_path: str | Path,
    scaler_path: str | Path,
    thresholds_path: str | Path,
) -> Optional[HealthyBundle]:
    ae_file = Path(ae_path)
    fc_file = Path(fc_path)
    scaler_file = Path(scaler_path)
    thresholds_file = Path(thresholds_path)
    required = [ae_file, fc_file, scaler_file, thresholds_file]
    if not all(p.exists() for p in required):
        return None

    try:
        mean, std, signal_cols = load_scaler_npz(scaler_file)
        ae_threshold, fc_threshold = load_thresholds(thresholds_file)
        ae_state, ae_config = load_torch_checkpoint(ae_file)
        fc_state, fc_config = load_torch_checkpoint(fc_file)
        config = {**ae_config, **fc_config}

        d_in = int(mean.shape[0])
        ae_model, fc_model = build_models(d_in, config)
        ae_model.load_state_dict(_normalize_state_dict(ae_state), strict=True)
        fc_model.load_state_dict(_normalize_state_dict(fc_state), strict=True)
        ae_model.to("cpu").eval()
        fc_model.to("cpu").eval()

        window_rows = _config_int(config, ["window_rows", "window_size", "seq_len", "timesteps"], 300)
        version = str(config.get("version") or f"{ae_file.name}+{fc_file.name}")

        return HealthyBundle(
            subsystem=str(subsystem).upper(),
            version=version,
            signal_cols=[str(x) for x in signal_cols],
            mean=mean.astype(np.float32),
            std=std.astype(np.float32),
            ae_threshold=float(ae_threshold),
            fc_threshold=float(fc_threshold),
            window_rows=int(window_rows),
            ae_model=ae_model,
            fc_model=fc_model,
        )
    except Exception as exc:
        logger.warning("Failed loading healthy bundle for %s: %s", subsystem, exc)
        return None


def score_window_ae(bundle: HealthyBundle, x_full_scaled: np.ndarray) -> Tuple[float, np.ndarray]:
    x = torch.from_numpy(x_full_scaled.astype(np.float32)).unsqueeze(0)
    with torch.no_grad():
        recon = bundle.ae_model(x)
        err = (recon - x) ** 2
        score = float(err.mean().item())
        per_feature = err.mean(dim=(0, 1)).detach().cpu().numpy().astype(np.float32)
    return score, per_feature


def score_window_fc(bundle: HealthyBundle, x_full_scaled: np.ndarray) -> Tuple[float, np.ndarray]:
    x = torch.from_numpy(x_full_scaled.astype(np.float32)).unsqueeze(0)
    if x.shape[1] < 2:
        return 0.0, np.zeros((x.shape[2],), dtype=np.float32)

    x_in = x[:, :-1, :]
    x_next = x[:, 1:, :]
    with torch.no_grad():
        y_hat = bundle.fc_model(x_in)
        err = (y_hat - x_next) ** 2
        score = float(err.mean().item())
        per_feature = err.mean(dim=(0, 1)).detach().cpu().numpy().astype(np.float32)
    return score, per_feature


def top_k_signals(per_feature_mse: np.ndarray, signal_cols: List[str], k: int = 3) -> List[str]:
    if per_feature_mse.size == 0 or not signal_cols:
        return []
    order = np.argsort(per_feature_mse)[::-1]
    top_idx = order[: max(1, int(k))]
    return [signal_cols[int(i)] for i in top_idx if int(i) < len(signal_cols)]
