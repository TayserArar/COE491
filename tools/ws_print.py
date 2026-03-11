import asyncio
import os

import websockets


async def main() -> None:
    url = os.getenv("WS_URL", "ws://localhost:8080/ws")
    subsystem = os.getenv("WS_SUBSYSTEM")
    if subsystem:
        url = f"{url}?subsystem={subsystem}"

    async with websockets.connect(url) as websocket:
        while True:
            message = await websocket.recv()
            print(message)


if __name__ == "__main__":
    asyncio.run(main())
