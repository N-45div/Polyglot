from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    project_id: str
    location: str
    model: str
    host: str
    port: int
    allowed_origins: list[str]
    default_voice: str
    default_language_code: str


DEFAULT_MODEL = "gemini-live-2.5-flash-preview-native-audio"
DEFAULT_LOCATION = "global"
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8000
DEFAULT_ALLOWED_ORIGINS = "*"
DEFAULT_VOICE = "Aoede"
DEFAULT_LANGUAGE_CODE = "en-US"


def _parse_allowed_origins(value: str) -> list[str]:
    origins = [item.strip() for item in value.split(",") if item.strip()]
    return origins or ["*"]


def get_settings() -> Settings:
    project_id = os.getenv("GOOGLE_CLOUD_PROJECT", "").strip()
    if not project_id:
        project_id = os.getenv("GCP_PROJECT_ID", "").strip()

    return Settings(
        project_id=project_id,
        location=os.getenv("GOOGLE_CLOUD_LOCATION", DEFAULT_LOCATION).strip() or DEFAULT_LOCATION,
        model=os.getenv("GEMINI_LIVE_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL,
        host=os.getenv("HOST", DEFAULT_HOST).strip() or DEFAULT_HOST,
        port=int(os.getenv("PORT", str(DEFAULT_PORT))),
        allowed_origins=_parse_allowed_origins(
            os.getenv("ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS)
        ),
        default_voice=os.getenv("DEFAULT_VOICE", DEFAULT_VOICE).strip() or DEFAULT_VOICE,
        default_language_code=os.getenv("DEFAULT_LANGUAGE_CODE", DEFAULT_LANGUAGE_CODE).strip()
        or DEFAULT_LANGUAGE_CODE,
    )
