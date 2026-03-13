from __future__ import annotations

import asyncio
import base64
import logging
import struct
from contextlib import suppress

from google import genai
from google.genai import types

from .config import Settings
from .schemas import SessionOptions

logger = logging.getLogger("polyglot.backend")

# ── Audio helpers ──────────────────────────────────────────────────────────

def pcm_to_wav(
    pcm_data: bytes, sample_rate: int = 24000,
    channels: int = 1, bits_per_sample: int = 16,
) -> bytes:
    """Convert raw PCM audio to WAV format so browsers can play it."""
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    data_size = len(pcm_data)
    wav_header = struct.pack(
        '<4sI4s4sIHHIIHH4sI',
        b'RIFF', 36 + data_size, b'WAVE', b'fmt ', 16, 1,
        channels, sample_rate, byte_rate, block_align,
        bits_per_sample, b'data', data_size,
    )
    return wav_header + pcm_data


# ── Sentinel to signal shutdown ────────────────────────────────────────────
_STOP = object()


# ── Main session class ─────────────────────────────────────────────────────

class GeminiLiveSession:
    """Queue-based concurrent Gemini Live session.

    Architecture (matches official Google demo):
      - audio_queue:  frontend → _send_loop → Gemini  (backpressure maxsize=5)
      - image_queue:  frontend → _send_loop → Gemini  (backpressure maxsize=2)
      - text_queue:   frontend → _send_loop → Gemini  (unbounded, rare)
      - output_queue:  Gemini → _receive_loop → frontend (unbounded)

    Three concurrent tasks run via asyncio.gather inside `run()`:
      1. _send_audio_loop  – drains audio_queue, sends to Gemini
      2. _send_media_loop  – drains image + text queues, sends to Gemini
      3. _receive_loop     – reads from Gemini, pushes to output_queue
    """

    def __init__(self, settings: Settings, options: SessionOptions):
        if not settings.project_id:
            raise ValueError(
                "GOOGLE_CLOUD_PROJECT or GCP_PROJECT_ID must be set."
            )
        self.settings = settings
        self.options = options
        self.client = genai.Client(
            vertexai=True,
            project=settings.project_id,
            location=settings.location,
        )
        # Queues with backpressure
        self.audio_queue: asyncio.Queue = asyncio.Queue(maxsize=5)
        self.image_queue: asyncio.Queue = asyncio.Queue(maxsize=2)
        self.text_queue: asyncio.Queue = asyncio.Queue()
        self.output_queue: asyncio.Queue = asyncio.Queue()

        self._session = None
        self._connect_context = None
        self._running = False

    # ── Public enqueue methods (called from websocket handler) ──────────

    def enqueue_audio(self, raw_pcm: bytes) -> None:
        """Non-blocking: drops oldest if queue full (backpressure)."""
        if self.audio_queue.full():
            try:
                self.audio_queue.get_nowait()  # drop oldest
            except asyncio.QueueEmpty:
                pass
        try:
            self.audio_queue.put_nowait(raw_pcm)
        except asyncio.QueueFull:
            pass  # skip this chunk

    def enqueue_image(self, image_bytes: bytes, mime_type: str = "image/jpeg") -> None:
        """Non-blocking: drops oldest if queue full."""
        if self.image_queue.full():
            try:
                self.image_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            self.image_queue.put_nowait((image_bytes, mime_type))
        except asyncio.QueueFull:
            pass

    async def enqueue_text(self, text: str) -> None:
        await self.text_queue.put(text)

    def stop(self) -> None:
        """Signal all loops to stop."""
        self._running = False
        with suppress(asyncio.QueueFull):
            self.audio_queue.put_nowait(_STOP)
        with suppress(asyncio.QueueFull):
            self.image_queue.put_nowait(_STOP)
        with suppress(asyncio.QueueFull):
            self.text_queue.put_nowait(_STOP)

    # ── Connect + Run ──────────────────────────────────────────────────

    async def connect(self) -> None:
        if self._session is not None:
            return
        config = types.LiveConnectConfig(
            response_modalities=[types.Modality.AUDIO],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=self.options.voice_name
                    )
                )
            ),
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            system_instruction=self._system_instruction(),
        )
        logger.info(f"Connecting to Gemini Live: {self.settings.model}")
        self._connect_context = self.client.aio.live.connect(
            model=self.settings.model, config=config,
        )
        self._session = await self._connect_context.__aenter__()
        self._running = True
        logger.info("Gemini Live session connected")

    async def run(self) -> None:
        """Run concurrent send/receive loops. Blocks until stopped."""
        if not self._session:
            raise RuntimeError("Call connect() first.")
        audio_task = asyncio.create_task(self._send_audio_loop())
        media_task = asyncio.create_task(self._send_media_loop())
        recv_task = asyncio.create_task(self._receive_loop())
        try:
            # Wait for receive loop to end (it drives the session lifetime)
            await recv_task
        except Exception as e:
            logger.error(f"Session run error: {e}")
        finally:
            self._running = False
            audio_task.cancel()
            media_task.cancel()
            with suppress(asyncio.CancelledError):
                await audio_task
            with suppress(asyncio.CancelledError):
                await media_task

    async def close(self) -> None:
        self.stop()
        if self._connect_context is not None:
            with suppress(Exception):
                await self._connect_context.__aexit__(None, None, None)
            self._connect_context = None
            self._session = None

    # ── Internal loops ─────────────────────────────────────────────────

    async def _send_audio_loop(self) -> None:
        """Drain audio queue → Gemini via send_realtime_input()."""
        chunks_sent = 0
        while self._running:
            try:
                chunk = await asyncio.wait_for(
                    self.audio_queue.get(), timeout=0.5
                )
            except asyncio.TimeoutError:
                continue
            if chunk is _STOP:
                break
            try:
                await self._session.send_realtime_input(
                    audio=types.Blob(data=chunk, mime_type="audio/pcm;rate=16000")
                )
                chunks_sent += 1
                if chunks_sent % 50 == 0:
                    logger.info(f"Audio chunks sent to Gemini: {chunks_sent}")
            except Exception as e:
                logger.error(f"Audio send error: {e}")
                if "close" in str(e).lower():
                    break

    async def _send_media_loop(self) -> None:
        """Drain image + text queues → Gemini."""
        while self._running:
            # Check text queue (non-blocking)
            try:
                item = self.text_queue.get_nowait()
                if item is _STOP:
                    break
                await self._session.send(
                    input=types.LiveClientContent(
                        turns=[types.Content(
                            role="user",
                            parts=[types.Part(text=item)],
                        )],
                        turn_complete=True,
                    ),
                    end_of_turn=True,
                )
                logger.info(f"Text sent to Gemini: {item[:50]}")
            except asyncio.QueueEmpty:
                pass
            except Exception as e:
                logger.error(f"Text send error: {e}")

            # Check image queue (non-blocking)
            try:
                item = self.image_queue.get_nowait()
                if item is _STOP:
                    break
                image_bytes, mime_type = item
                await self._session.send_realtime_input(
                    video=types.Blob(data=image_bytes, mime_type=mime_type)
                )
                logger.info(f"Image sent to Gemini ({len(image_bytes)} bytes)")
            except asyncio.QueueEmpty:
                pass
            except Exception as e:
                logger.error(f"Image send error: {e}")

            await asyncio.sleep(0.05)  # yield to event loop

    async def _receive_loop(self) -> None:
        """Read from Gemini → output_queue for frontend.
        
        CRITICAL: session.receive() iterator ends after each turn.
        Must wrap in while True to keep receiving across multiple turns.
        This matches the official Google demo pattern.
        """
        logger.info("Receive loop started")
        try:
            while self._running:
                async for message in self._session.receive():
                    if not self._running:
                        break
                    server_content = getattr(message, "server_content", None)
                    if not server_content:
                        continue

                    # Handle interruption (user started speaking)
                    if getattr(server_content, "interrupted", False):
                        logger.info("Turn interrupted by user")
                        await self.output_queue.put(
                            {"type": "interrupted", "data": {}}
                        )

                    # Model audio/text output
                    model_turn = getattr(server_content, "model_turn", None)
                    if model_turn and getattr(model_turn, "parts", None):
                        for part in model_turn.parts:
                            inline_data = getattr(part, "inline_data", None)
                            if inline_data and getattr(inline_data, "data", None):
                                wav = pcm_to_wav(inline_data.data, sample_rate=24000)
                                encoded = base64.b64encode(wav).decode("utf-8")
                                await self.output_queue.put({
                                    "type": "output.audio",
                                    "data": {
                                        "mime_type": "audio/wav",
                                        "audio_base64": encoded,
                                    },
                                })
                            text = getattr(part, "text", None)
                            if text:
                                await self.output_queue.put({
                                    "type": "transcript.model",
                                    "data": {"text": text},
                                })

                    # Turn complete
                    if getattr(server_content, "turn_complete", False):
                        logger.info("Gemini turn complete, ready for next input")

                    # Input transcription
                    input_tx = getattr(server_content, "input_transcription", None)
                    if input_tx and getattr(input_tx, "text", None):
                        await self.output_queue.put({
                            "type": "transcript.user",
                            "data": {"text": input_tx.text},
                        })

                    # Output transcription
                    output_tx = getattr(server_content, "output_transcription", None)
                    if output_tx and getattr(output_tx, "text", None):
                        await self.output_queue.put({
                            "type": "transcript.model",
                            "data": {"text": output_tx.text},
                        })
        except Exception as e:
            logger.error(f"Receive loop error: {e}")
            await self.output_queue.put({
                "type": "error",
                "data": {"message": str(e)},
            })
        finally:
            logger.info("Receive loop ended")
            await self.output_queue.put(_STOP)

    # ── Helpers ────────────────────────────────────────────────────────

    def _system_instruction(self) -> types.Content:
        base = (
            "You are Polyglot, a friendly multilingual live screen companion. "
            "You're having a natural voice conversation with the user. "
            "Keep responses concise (1-3 sentences) unless they ask for detail. "
            "Reference what you see on their screen when relevant. "
            "Ask follow-up questions to keep the conversation flowing. "
            f"Always respond in {self.options.language_code}."
        )
        if self.options.system_instruction:
            base = f"{base}\n\n{self.options.system_instruction.strip()}"
        return types.Content(parts=[types.Part(text=base)])
