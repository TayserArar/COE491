import asyncio
import os
from api.app.helpers import iter_rows_from_bytes, build_message_samples

with open(r"C:\Users\Tayseer\Desktop\COE491\30L GP\1JAN\ContMon 2025-01-01-a.log", "rb") as f:
    data = f.read()

rows = list(iter_rows_from_bytes(data))
print(f"Total rows: {len(rows)}")

samples = build_message_samples(rows)
print(f"Total samples: {len(samples)}")
