from __future__ import annotations

import base64
from typing import AsyncIterator

from google import genai
from google.genai import types

from .config import Settings
from .schemas import SessionOptions


class GeminiLiveSession:
    def __init__(self, settings: Settings, options: SessionOptions):
        if not settings.project_id:
            raise ValueError(
                "GOOGLE_CLOUD_PROJECT or GCP_PROJECT_ID must be set before starting a live session."
            )

        self.settings = settings
        self.options = options
        self.client = genai.Client(
            vertexai=True,
            project=settings.project_id,
            location=settings.location,
        )
        self._connect_context = None
        self._session = None

    async def connect(self) -> None:
        if self._session is not None:
            return

        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            media_resolution="low",
            input_audio_transcription={},
            output_audio_transcription={},
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=self.options.voice_name
                    )
                ),
                language_code=self.options.language_code,
            ),
            realtime_input_config=types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(
                    disabled=False,
                    start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_LOW,
                    end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_LOW,
                    prefix_padding_ms=20,
                    silence_duration_ms=100,
                )
            ),
            system_instruction=self._system_instruction(),
        )
        self._connect_context = self.client.aio.live.connect(
            model=self.settings.model,
            config=config,
        )
        self._session = await self._connect_context.__aenter__()

    async def close(self) -> None:
        if self._connect_context is not None:
            await self._connect_context.__aexit__(None, None, None)
            self._connect_context = None
            self._session = None

    async def __aenter__(self) -> "GeminiLiveSession":
        await self.connect()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    def _system_instruction(self) -> types.Content:
        base_instruction = (
            "You are Polyglot, a multilingual live screen companion. "
            "Ground every answer in the user's visible screen, spoken question, or explicit text input. "
            "If the screen context is missing or ambiguous, say so clearly and ask a brief follow-up. "
            f"Respond unmistakably in {self.options.language_code}."
        )
        if self.options.system_instruction:
            base_instruction = f"{base_instruction}\n\n{self.options.system_instruction.strip()}"
        return types.Content(parts=[types.Part(text=base_instruction)])

    async def send_text(self, text: str) -> None:
        if not self._session:
            raise RuntimeError("Live session is not connected.")
        await self._session.send_client_content(
            turns=types.Content(role="user", parts=[types.Part(text=text)]),
            turn_complete=True,
        )

    async def send_audio_chunk(self, raw_pcm: bytes) -> None:
        if not self._session:
            raise RuntimeError("Live session is not connected.")
        await self._session.send_realtime_input(
            audio=types.Blob(data=raw_pcm, mime_type="audio/pcm;rate=16000")
        )

    async def finish_audio(self) -> None:
        if not self._session:
            raise RuntimeError("Live session is not connected.")
        await self._session.send_realtime_input(audio_stream_end=True)

    async def send_image_chunk(self, image_bytes: bytes, mime_type: str = "image/jpeg") -> None:
        if not self._session:
            raise RuntimeError("Live session is not connected.")
        await self._session.send_realtime_input(
            media=types.Blob(data=image_bytes, mime_type=mime_type)
        )

    async def receive(self) -> AsyncIterator[dict]:
        if not self._session:
            raise RuntimeError("Live session is not connected.")

        async for message in self._session.receive():
            server_content = getattr(message, "server_content", None)
            if not server_content:
                continue

            if getattr(server_content, "interrupted", False):
                yield {"type": "interrupted", "data": {}}

            model_turn = getattr(server_content, "model_turn", None)
            if model_turn and getattr(model_turn, "parts", None):
                for part in model_turn.parts:
                    inline_data = getattr(part, "inline_data", None)
                    if inline_data and getattr(inline_data, "data", None):
                        encoded = base64.b64encode(inline_data.data).decode("utf-8")
                        yield {
                            "type": "output.audio",
                            "data": {
                                "mime_type": inline_data.mime_type,
                                "audio_base64": encoded,
                            },
                        }
                    text = getattr(part, "text", None)
                    if text:
                        yield {
                            "type": "transcript.model",
                            "data": {"text": text},
                        }

            input_transcription = getattr(server_content, "input_transcription", None)
            if input_transcription and getattr(input_transcription, "text", None):
                yield {
                    "type": "transcript.user",
                    "data": {"text": input_transcription.text},
                }

            output_transcription = getattr(server_content, "output_transcription", None)
            if output_transcription and getattr(output_transcription, "text", None):
                yield {
                    "type": "transcript.model",
                    "data": {"text": output_transcription.text},
                }
