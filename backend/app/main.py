from __future__ import annotations

import asyncio
import base64
import json
import logging
from contextlib import suppress

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from .config import get_settings
from .gemini_live import GeminiLiveSession
from .schemas import ClientEnvelope, ServerEnvelope, SessionOptions


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("polyglot.backend")
settings = get_settings()

app = FastAPI(title="Polyglot Backend", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "project_configured": bool(settings.project_id),
            "location": settings.location,
            "model": settings.model,
        }
    )


@app.websocket("/ws/live")
async def live_session(websocket: WebSocket) -> None:
    await websocket.accept()
    gemini_session: GeminiLiveSession | None = None
    run_task: asyncio.Task | None = None
    output_task: asyncio.Task | None = None

    try:
        while True:
            raw_message = await websocket.receive_text()
            try:
                envelope = ClientEnvelope.model_validate_json(raw_message)
            except ValidationError as exc:
                await websocket.send_text(
                    ServerEnvelope(
                        type="error",
                        data={"message": f"Invalid client message: {exc.errors()[0]['msg']}"},
                    ).model_dump_json()
                )
                continue

            if envelope.type == "ping":
                await websocket.send_text(
                    ServerEnvelope(type="pong", data={}).model_dump_json()
                )
                continue

            if envelope.type == "session.start":
                if gemini_session is not None:
                    await websocket.send_text(
                        ServerEnvelope(
                            type="error",
                            data={"message": "Session already started."},
                        ).model_dump_json()
                    )
                    continue

                options = SessionOptions(
                    language_code=envelope.data.get(
                        "language_code", settings.default_language_code
                    ),
                    voice_name=envelope.data.get("voice_name", settings.default_voice),
                    system_instruction=envelope.data.get("system_instruction"),
                )
                gemini_session = GeminiLiveSession(settings, options)
                await gemini_session.connect()
                # Start concurrent send/receive loops
                run_task = asyncio.create_task(gemini_session.run())
                # Start output drainer → frontend
                output_task = asyncio.create_task(
                    _drain_output(gemini_session, websocket)
                )
                await websocket.send_text(
                    ServerEnvelope(
                        type="session.ready",
                        data={
                            "language_code": options.language_code,
                            "voice_name": options.voice_name,
                            "model": settings.model,
                        },
                    ).model_dump_json()
                )
                continue

            if gemini_session is None:
                await websocket.send_text(
                    ServerEnvelope(
                        type="error",
                        data={"message": "Start a session first."},
                    ).model_dump_json()
                )
                continue

            # All enqueue calls are non-blocking → event loop stays free
            if envelope.type == "input.text":
                text = envelope.data.get("text", "").strip()
                if text:
                    logger.info(f"Enqueuing text: {text[:50]}")
                    await gemini_session.enqueue_text(text)
                continue

            if envelope.type == "input.audio":
                audio_base64 = envelope.data.get("audio_base64", "")
                if audio_base64:
                    gemini_session.enqueue_audio(base64.b64decode(audio_base64))
                continue

            if envelope.type == "input.image":
                image_base64 = envelope.data.get("image_base64", "")
                mime_type = envelope.data.get("mime_type", "image/jpeg")
                if image_base64:
                    gemini_session.enqueue_image(
                        base64.b64decode(image_base64), mime_type=mime_type
                    )
                continue

            if envelope.type == "session.stop":
                break

    except WebSocketDisconnect:
        logger.info("Client disconnected from live session")
    except Exception as exc:
        logger.exception("Live session failure")
        with suppress(RuntimeError):
            await websocket.send_text(
                ServerEnvelope(
                    type="error",
                    data={"message": str(exc)},
                ).model_dump_json()
            )
    finally:
        if gemini_session is not None:
            await gemini_session.close()
        if run_task is not None:
            run_task.cancel()
            with suppress(asyncio.CancelledError):
                await run_task
        if output_task is not None:
            output_task.cancel()
            with suppress(asyncio.CancelledError):
                await output_task
        with suppress(RuntimeError):
            await websocket.close()


async def _drain_output(
    gemini_session: GeminiLiveSession, websocket: WebSocket
) -> None:
    """Drain output_queue from Gemini → send to frontend via websocket."""
    from .gemini_live import _STOP
    audio_events = 0
    try:
        while True:
            event = await gemini_session.output_queue.get()
            if event is _STOP:
                break
            etype = event.get("type", "")
            if etype == "output.audio":
                audio_events += 1
                if audio_events % 10 == 1:
                    logger.info(f"Streaming audio to frontend (event #{audio_events})")
            else:
                logger.info(f"Gemini → frontend: {etype}")
            await websocket.send_text(json.dumps(event))
    except Exception as exc:
        logger.error(f"Output drain error: {exc}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=True,
    )
