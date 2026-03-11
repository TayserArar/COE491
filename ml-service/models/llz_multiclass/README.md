# Place the four LLZ multiclass notebook artifacts here before starting:
#
#   best_model_filtered.pt         — trained PyTorch model weights
#   training_artifacts.json        — must contain feature_columns + label_map_filtered
#   scaler.joblib                  — fitted sklearn scaler
#   feature_transform.joblib       — optional sklearn transform (PCA etc.)
#
# The directory is bind-mounted read-only into the ml-service container at
#   /app/models/llz_multiclass/
