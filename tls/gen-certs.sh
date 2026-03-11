#!/usr/bin/env bash
# gen-certs.sh — Generate a self-signed TLS certificate for local development.
# Run once from the project root:  bash tls/gen-certs.sh
# For production, replace cert.pem and key.pem with real certificates.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR"

echo "[tls] Generating self-signed certificate in $OUT_DIR ..."

openssl req -x509 \
  -newkey rsa:4096 \
  -keyout "$OUT_DIR/key.pem" \
  -out    "$OUT_DIR/cert.pem" \
  -days   365 \
  -nodes \
  -subj   "/C=AE/ST=Dubai/L=Dubai/O=COE491/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

chmod 0640 "$OUT_DIR/key.pem" "$OUT_DIR/cert.pem"

echo "[tls] Done. Files written:"
echo "      $OUT_DIR/cert.pem"
echo "      $OUT_DIR/key.pem"
echo ""
echo "NOTE: Browsers will warn about self-signed certs."
echo "      For production replace these files with real certificates."
