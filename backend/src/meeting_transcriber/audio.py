"""Validation helpers for the sidecar's fixed PCM wire format."""

from __future__ import annotations

import base64
import binascii
import math
import struct


SAMPLE_RATE_HZ = 16_000
SAMPLE_WIDTH_BYTES = 2
MAX_PACKET_BYTES = SAMPLE_RATE_HZ * SAMPLE_WIDTH_BYTES * 10


class PcmValidationError(ValueError):
    """Raised when a wire packet is not valid 16 kHz mono signed PCM."""


def decode_pcm_s16le_base64(value: object) -> bytes:
    if not isinstance(value, str):
        raise PcmValidationError("pcm_s16le_base64 must be a base64 string")
    try:
        pcm = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise PcmValidationError("pcm_s16le_base64 is not valid base64") from exc
    validate_pcm_s16le(pcm)
    return pcm


def validate_pcm_s16le(pcm: bytes) -> None:
    if not pcm:
        raise PcmValidationError("PCM packet must not be empty")
    if len(pcm) % SAMPLE_WIDTH_BYTES:
        raise PcmValidationError("PCM packet must contain complete signed 16-bit samples")
    if len(pcm) > MAX_PACKET_BYTES:
        raise PcmValidationError("PCM packet exceeds the 10 second safety limit")


def sample_count(pcm: bytes) -> int:
    validate_pcm_s16le(pcm)
    return len(pcm) // SAMPLE_WIDTH_BYTES


def duration_ms(pcm: bytes) -> int:
    """Return the closest integral millisecond for a PCM packet."""

    samples = sample_count(pcm)
    return max(1, int(round(samples * 1000 / SAMPLE_RATE_HZ)))


def rms_level(pcm: bytes) -> float:
    """Calculate PCM RMS without importing NumPy on the protocol hot path."""

    count = sample_count(pcm)
    sum_squares = 0
    for (value,) in struct.iter_unpack("<h", pcm):
        sum_squares += value * value
    return math.sqrt(sum_squares / count)

