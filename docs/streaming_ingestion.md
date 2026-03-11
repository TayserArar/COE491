# Streaming Ingestion (MQTT + WebSocket)

## Run

```bash
docker compose up --build
```

- Ingestion service: http://localhost:8080
- MQTT broker: localhost:1883
- Frontend: http://localhost:8081

## Change the publish rate

Set `RATE_HZ` in `docker-compose.yml` under `fake-ils`.

## Real log files

- Fake ILS reads NORMARC `.log` files from `30L LLZ` and `30L GP`.
- It skips the first 17 header lines and expects a `Timestamp` column.
- Only numeric columns are published; `Status` columns are ignored.
- Timestamps are emitted as UTC ISO strings.

## Topics

- `ils/llz/telemetry`
- `ils/gp/telemetry`

## Payload schema

```json
{
  "source_id": "string",
  "subsystem": "llz" | "gp",
  "ts": "ISO-8601 timestamp",
  "seq": 1,
  "signals": {
    "<column_name>": 0.0
  }
}
```

## Frontend

- Uploads removed; dashboard is live-telemetry only.
- WebSocket source: ws://localhost:8080/ws?subsystem=all
- Frontend URL: http://localhost:8081

## Quick tests

Health:

```bash
curl http://localhost:8080/health
```

Latest per subsystem:

```bash
curl http://localhost:8080/latest/llz
curl http://localhost:8080/latest/gp
```

WebSocket stream (Python client):

```bash
pip install -r tools/requirements.txt
python tools/ws_print.py
```

Optional filter:

```bash
WS_SUBSYSTEM=llz python tools/ws_print.py
```
