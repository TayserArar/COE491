#!/bin/sh
set -e

: "${MQTT_PRODUCER_USER:?MQTT_PRODUCER_USER is required}"
: "${MQTT_PRODUCER_PASS:?MQTT_PRODUCER_PASS is required}"
: "${MQTT_INGESTION_USER:?MQTT_INGESTION_USER is required}"
: "${MQTT_INGESTION_PASS:?MQTT_INGESTION_PASS is required}"

PASSFILE="/mosquitto/custom/passwordfile"
TLS_DIR="/mosquitto/tls"
CERT_PATH="$TLS_DIR/cert.pem"
KEY_PATH="$TLS_DIR/key.pem"

mkdir -p /mosquitto/custom
chown -R mosquitto:mosquitto /mosquitto/custom

mkdir -p "$TLS_DIR"
if [ ! -s "$CERT_PATH" ] || [ ! -s "$KEY_PATH" ]; then
    echo "[mosquitto] No TLS cert/key provided. Generating self-signed development certificate."
    openssl req -x509 -nodes -newkey rsa:2048 \
        -keyout "$KEY_PATH" \
        -out "$CERT_PATH" \
        -days 365 \
        -subj "/C=AE/ST=Dubai/L=Dubai/O=COE491/CN=localhost" \
        -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:mqtt-broker"
    chown mosquitto:mosquitto "$CERT_PATH" "$KEY_PATH"
    chmod 0644 "$CERT_PATH"
    chmod 0600 "$KEY_PATH"
fi

rm -f "$PASSFILE"
mosquitto_passwd -b -c "$PASSFILE" "$MQTT_PRODUCER_USER" "$MQTT_PRODUCER_PASS"
mosquitto_passwd -b "$PASSFILE" "$MQTT_INGESTION_USER" "$MQTT_INGESTION_PASS"
chown mosquitto:mosquitto "$PASSFILE"
chmod 0640 "$PASSFILE"

exec mosquitto -c /mosquitto/custom/mosquitto.conf
