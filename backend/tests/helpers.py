from __future__ import annotations

import base64
import struct


def pcm(duration_ms: int, value: int = 1_000) -> bytes:
    return struct.pack("<h", value) * (16 * duration_ms)


def pcm_base64(duration_ms: int, value: int = 1_000) -> str:
    return base64.b64encode(pcm(duration_ms, value)).decode("ascii")

