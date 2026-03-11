#!/bin/sh
set -e

TLS_DIR="/etc/nginx/tls"
CERT_PATH="$TLS_DIR/cert.pem"
KEY_PATH="$TLS_DIR/key.pem"

mkdir -p "$TLS_DIR"

if [ ! -s "$CERT_PATH" ] || [ ! -s "$KEY_PATH" ]; then
    echo "[nginx] No TLS cert/key provided. Generating self-signed development certificate."
    openssl req -x509 -nodes -newkey rsa:2048 \
        -keyout "$KEY_PATH" \
        -out "$CERT_PATH" \
        -days 365 \
        -subj "/C=AE/ST=Dubai/L=Dubai/O=COE491/CN=localhost" \
        -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:nginx-proxy"
    chmod 0600 "$KEY_PATH"
    chmod 0644 "$CERT_PATH"
fi

exec nginx -g "daemon off;"
