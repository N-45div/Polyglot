from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


ClientMessageType = Literal["session.start", "input.audio", "input.image", "input.text", "session.stop", "ping"]
ServerMessageType = Literal[
    "session.ready",
    "transcript.user",
    "transcript.model",
    "output.audio",
    "interrupted",
    "error",
    "pong",
]


class SessionOptions(BaseModel):
    language_code: str = Field(default="en-US")
    voice_name: str = Field(default="Aoede")
    system_instruction: Optional[str] = None


class ClientEnvelope(BaseModel):
    type: ClientMessageType
    data: dict = Field(default_factory=dict)


class ServerEnvelope(BaseModel):
    type: ServerMessageType
    data: dict = Field(default_factory=dict)
