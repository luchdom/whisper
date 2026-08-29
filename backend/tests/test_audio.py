from __future__ import annotations

import unittest

from meeting_transcriber.audio import (
    PcmValidationError,
    decode_pcm_s16le_base64,
    duration_ms,
    rms_level,
    validate_pcm_s16le,
)
from tests.helpers import pcm, pcm_base64


class AudioTests(unittest.TestCase):
    def test_validates_and_measures_pcm(self) -> None:
        raw = pcm(100, 2_000)
        self.assertEqual(decode_pcm_s16le_base64(pcm_base64(100, 2_000)), raw)
        self.assertEqual(duration_ms(raw), 100)
        self.assertAlmostEqual(rms_level(raw), 2_000.0)

    def test_rejects_invalid_base64_empty_and_odd_pcm(self) -> None:
        with self.assertRaisesRegex(PcmValidationError, "valid base64"):
            decode_pcm_s16le_base64("%%%")
        with self.assertRaisesRegex(PcmValidationError, "must not be empty"):
            validate_pcm_s16le(b"")
        with self.assertRaisesRegex(PcmValidationError, "complete signed 16-bit"):
            validate_pcm_s16le(b"\x00")


if __name__ == "__main__":
    unittest.main()

