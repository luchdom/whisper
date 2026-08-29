"""Headless, local-first meeting transcription sidecar."""

from .engine import EngineSettings, FakeTranscriptionEngine, TranscriptionResult
from .service import JsonlApplication, TranscriptionService

__all__ = [
    "EngineSettings",
    "FakeTranscriptionEngine",
    "JsonlApplication",
    "TranscriptionResult",
    "TranscriptionService",
]

__version__ = "0.1.0"

