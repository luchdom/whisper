"""Typed JSON Lines command parsing and event serialization."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
from typing import Any, Literal, Mapping, TypeAlias

from .audio import PcmValidationError, decode_pcm_s16le_base64, duration_ms


Track: TypeAlias = Literal["system", "microphone"]
MAX_SEGMENT_TEXT_CHARS = 20_000


class ProtocolError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class ConfigureCommand:
    changes: dict[str, object]


@dataclass(frozen=True, slots=True)
class StartCommand:
    changes: dict[str, object]


@dataclass(frozen=True, slots=True)
class AudioCommand:
    track: Track
    start_ms: int
    end_ms: int
    pcm_s16le: bytes


@dataclass(frozen=True, slots=True)
class StopCommand:
    pass


@dataclass(frozen=True, slots=True)
class FlushCommand:
    pass


@dataclass(frozen=True, slots=True)
class ShutdownCommand:
    pass


Command: TypeAlias = (
    ConfigureCommand | StartCommand | AudioCommand | StopCommand | FlushCommand | ShutdownCommand
)


@dataclass(frozen=True, slots=True)
class SegmentPayload:
    id: str
    revision: int
    start_ms: int
    end_ms: int
    track: Track
    text: str
    partial: bool
    final: bool
    language: str | None
    speaker_id: str | None = None
    translated_text: str | None = None
    translated_language: str | None = None

    def __post_init__(self) -> None:
        _validate_text_field(self.text, "Segment text", nullable=False)
        _validate_text_field(self.translated_text, "Translated segment text", nullable=True)
        if self.partial and self.translated_text is not None:
            raise ValueError("Partial segments must not contain translated text")
        if self.translated_text is None:
            if self.translated_language is not None:
                raise ValueError("translated_language must be null when translated_text is null")
        elif self.translated_language != "pt-BR":
            raise ValueError("translated_language must be 'pt-BR' when translated_text is present")


_SETTING_FIELDS = {
    "model",
    "language",
    "device",
    "compute",
    "download_root",
    "diarization",
    "diarization_model",
    "translation",
    "translation_model",
}


def parse_command(line: str) -> Command:
    try:
        payload = json.loads(line)
    except json.JSONDecodeError as exc:
        raise ProtocolError("invalid_json", f"Invalid JSON at character {exc.pos}") from exc
    if not isinstance(payload, dict):
        raise ProtocolError("invalid_command", "Each line must be a JSON object")

    command_type = payload.get("type")
    if not isinstance(command_type, str):
        raise ProtocolError("invalid_command", "Command field 'type' must be a string")

    if command_type in {"configure", "start"}:
        _reject_unknown(payload, {"type", *_SETTING_FIELDS})
        changes = _parse_settings(payload)
        return ConfigureCommand(changes) if command_type == "configure" else StartCommand(changes)
    if command_type == "audio":
        _reject_unknown(payload, {"type", "track", "start_ms", "end_ms", "pcm_s16le_base64"})
        return _parse_audio(payload)
    if command_type in {"stop", "flush", "shutdown"}:
        _reject_unknown(payload, {"type"})
        return {
            "stop": StopCommand,
            "flush": FlushCommand,
            "shutdown": ShutdownCommand,
        }[command_type]()
    raise ProtocolError("unknown_command", f"Unknown command type '{command_type}'")


def _parse_settings(payload: Mapping[str, Any]) -> dict[str, object]:
    changes: dict[str, object] = {}
    for field in _SETTING_FIELDS:
        if field not in payload:
            continue
        value = payload[field]
        if field in {"language", "download_root", "diarization_model", "translation_model"} and value is None:
            changes[field] = None
        elif field == "diarization":
            if not isinstance(value, str) or value not in {"off", "online"}:
                raise ProtocolError("invalid_configuration", "'diarization' must be 'off' or 'online'")
            changes[field] = value
        elif field == "translation":
            if not isinstance(value, str) or value not in {"off", "en_to_pt_br"}:
                raise ProtocolError(
                    "invalid_configuration",
                    "'translation' must be 'off' or 'en_to_pt_br'",
                )
            changes[field] = value
        elif not isinstance(value, str) or not value.strip():
            raise ProtocolError("invalid_configuration", f"'{field}' must be a non-empty string or null")
        else:
            normalized = value.strip()
            if field in {"diarization_model", "translation_model"} and (
                len(normalized) > 4_096 or "\x00" in normalized
            ):
                raise ProtocolError(
                    "invalid_configuration",
                    f"'{field}' must be a valid local path or null",
                )
            changes[field] = normalized
    return changes


def _parse_audio(payload: Mapping[str, Any]) -> AudioCommand:
    track = payload.get("track")
    if track not in {"system", "microphone"}:
        raise ProtocolError("invalid_audio", "track must be 'system' or 'microphone'")
    start_ms = payload.get("start_ms")
    if isinstance(start_ms, bool) or not isinstance(start_ms, int) or start_ms < 0:
        raise ProtocolError("invalid_audio", "start_ms must be a non-negative integer")
    try:
        pcm = decode_pcm_s16le_base64(payload.get("pcm_s16le_base64"))
    except PcmValidationError as exc:
        raise ProtocolError("invalid_audio", str(exc)) from exc
    calculated_end_ms = start_ms + duration_ms(pcm)
    supplied_end_ms = payload.get("end_ms", calculated_end_ms)
    if isinstance(supplied_end_ms, bool) or not isinstance(supplied_end_ms, int):
        raise ProtocolError("invalid_audio", "end_ms must be an integer when supplied")
    if supplied_end_ms != calculated_end_ms:
        raise ProtocolError(
            "invalid_audio",
            "end_ms does not match the duration of the 16 kHz PCM packet",
        )
    return AudioCommand(track=track, start_ms=start_ms, end_ms=calculated_end_ms, pcm_s16le=pcm)


def _reject_unknown(payload: Mapping[str, Any], allowed: set[str]) -> None:
    unknown = sorted(set(payload) - allowed)
    if unknown:
        raise ProtocolError("invalid_command", f"Unknown field(s): {', '.join(unknown)}")


def serialize_event(event: Mapping[str, Any]) -> str:
    event_type = event.get("type")
    if not isinstance(event_type, str) or not event_type:
        raise ProtocolError("invalid_event", "Event must have a non-empty type")
    if event_type in {"partial_transcript", "final_segment"}:
        _validate_segment_event(event_type, event)
    return json.dumps(dict(event), ensure_ascii=False, separators=(",", ":"))


def segment_event(
    event_type: Literal["partial_transcript", "final_segment"],
    session_id: str,
    segment: SegmentPayload,
) -> dict[str, object]:
    payload = asdict(segment)
    event: dict[str, object] = {"type": event_type, "session_id": session_id, "segment": payload}
    _validate_segment_event(event_type, event)
    return event


def _validate_segment_event(event_type: str, event: Mapping[str, Any]) -> None:
    session_id = event.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        raise ProtocolError("invalid_event", "Transcript event requires a non-empty session_id")
    segment = event.get("segment")
    if not isinstance(segment, Mapping):
        raise ProtocolError("invalid_event", "Transcript event requires a segment object")
    partial = segment.get("partial")
    final = segment.get("final")
    if not isinstance(partial, bool) or not isinstance(final, bool) or partial == final:
        raise ProtocolError("invalid_event", "Segment partial and final flags must be complementary")
    if event_type == "partial_transcript" and not partial:
        raise ProtocolError("invalid_event", "Partial transcript event must have partial=true")
    if event_type == "final_segment" and not final:
        raise ProtocolError("invalid_event", "Final segment event must have final=true")
    try:
        _validate_text_field(segment.get("text"), "Segment text", nullable=False)
        translated_text = segment.get("translated_text")
        translated_language = segment.get("translated_language")
        _validate_text_field(translated_text, "Translated segment text", nullable=True)
        if partial and translated_text is not None:
            raise ValueError("Partial segments must not contain translated text")
        if translated_text is None:
            if translated_language is not None:
                raise ValueError("translated_language must be null when translated_text is null")
        elif translated_language != "pt-BR":
            raise ValueError("translated_language must be 'pt-BR' when translated_text is present")
    except ValueError as exc:
        raise ProtocolError("invalid_event", str(exc)) from exc


def _validate_text_field(value: object, label: str, *, nullable: bool) -> None:
    if value is None and nullable:
        return
    if not isinstance(value, str) or len(value) > MAX_SEGMENT_TEXT_CHARS or "\x00" in value:
        qualifier = "a bounded string or null" if nullable else "a bounded string"
        raise ValueError(f"{label} must be {qualifier}")


def issue_event(
    kind: Literal["warning", "error"],
    *,
    source: Literal["protocol", "capture", "transcription"],
    code: str,
    message: str,
    recoverable: bool,
    segment_id: str | None = None,
) -> dict[str, object]:
    event: dict[str, object] = {
        "type": kind,
        "source": source,
        "code": code,
        "message": message,
        "recoverable": recoverable,
    }
    if segment_id is not None:
        event["segment_id"] = segment_id
    return event
