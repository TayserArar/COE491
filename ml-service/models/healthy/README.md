# Healthy Model Artifacts

Drop PyTorch healthy-only artifacts in this folder before starting `ml-service`.

Required files:

- `gp_ae.pt`
- `gp_fc.pt`
- `gp_scaler.npz`
- `gp_thresholds.json`
- `llz_ae.pt`
- `llz_fc.pt`
- `llz_scaler.npz`
- `llz_thresholds.json`

Expected formats:

- `*_ae.pt` and `*_fc.pt`: either `torch.save(state_dict)` or `torch.save({"state_dict": ..., "config": ...})`
- `*_scaler.npz`: scaler arrays with keys `mean/std` (or `mu/sigma`, or `x_mean/x_std`) and optional `signal_cols`
- `*_thresholds.json`: JSON object with `ae_threshold` and `fc_threshold`
