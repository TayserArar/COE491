#!/bin/sh
set -e

: "${MQTT_PRODUCER_USER:?MQTT_PRODUCER_USER is required}"
: "${MQTT_PRODUCER_PASS:?MQTT_PRODUCER_PASS is required}"
: "${MQTT_INGESTION_USER:?MQTT_INGESTION_USER is required}"
: "${MQTT_INGESTION_PASS:?MQTT_INGESTION_PASS is required}"

PASSFILE="/mosquitto/custom/passwordfile"

mkdir -p /mosquitto/custom
chown -R mosquitto:mosquitto /mosquitto/custom

rm -f "$PASSFILE"
mosquitto_passwd -b -c "$PASSFILE" "$MQTT_PRODUCER_USER" "$MQTT_PRODUCER_PASS"
mosquitto_passwd -b "$PASSFILE" "$MQTT_INGESTION_USER" "$MQTT_INGESTION_PASS"
chown mosquitto:mosquitto "$PASSFILE"
chmod 0640 "$PASSFILE"

exec mosquitto -c /mosquitto/custom/mosquitto.conf
