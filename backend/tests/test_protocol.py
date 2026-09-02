from __future__ import annotations

import json
import unittest

from meeting_transcriber.protocol import (
    AudioCommand,
    ConfigureCommand,
    ProtocolError,
    SegmentPayload,
    StartCommand,
    parse_command,
    segment_event,
    segment_translation_event,
    serialize_event,
)
from tests.helpers import pcm_base64


class ProtocolTests(unittest.TestCase):
    def test_parses_configuration_and_start_overrides(self) -> None:
        configured = parse_command(
            '{"type":"configure","model":"small","language":null,"device":"cpu",'
            '"compute":"int8","download_root":"C:/models","diarization":"online",'
            '"diarization_model":"C:/models/wespeaker.onnx","translation":"en_to_pt_br",'
            '"translation_model":"C:/models/translation"}'
        )
        self.assertIsInstance(configured, ConfigureCommand)
        self.assertEqual(configured.changes["compute"], "int8")
        self.assertEqual(configured.changes["diarization"], "online")
        self.assertEqual(configured.changes["diarization_model"], "C:/models/wespeaker.onnx")
        self.assertEqual(configured.changes["translation"], "en_to_pt_br")
        self.assertEqual(configured.changes["translation_model"], "C:/models/translation")
        started = parse_command('{"type":"start","language":"pt"}')
        self.assertIsInstance(started, StartCommand)
        self.assertEqual(started.changes, {"language": "pt"})

    def test_diarization_settings_are_strict_and_nullable_only_where_supported(self) -> None:
        disabled = parse_command('{"type":"start","diarization":"off","diarization_model":null}')
        self.assertEqual(disabled.changes, {"diarization": "off", "diarization_model": None})
        for invalid in ('"cloud"', 'true', 'null', '[]'):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ProtocolError, "off.*online"):
                parse_command(f'{{"type":"start","diarization":{invalid}}}')
        with self.assertRaisesRegex(ProtocolError, "valid local path"):
            parse_command('{"type":"start","diarization_model":"bad\\u0000path"}')

        translated = parse_command(
            '{"type":"start","translation":"en_to_pt_br","translation_model":null}'
        )
        self.assertEqual(
            translated.changes,
            {"translation": "en_to_pt_br", "translation_model": None},
        )
        for invalid in ('"cloud"', 'true', 'null', '[]'):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(
                ProtocolError,
                "off.*en_to_pt_br",
            ):
                parse_command(f'{{"type":"start","translation":{invalid}}}')
        with self.assertRaisesRegex(ProtocolError, "valid local path"):
            parse_command('{"type":"start","translation_model":"bad\\u0000path"}')

    def test_parses_audio_and_derives_exact_end(self) -> None:
        command = parse_command(
            json.dumps(
                {
                    "type": "audio",
                    "track": "microphone",
                    "start_ms": 250,
                    "end_ms": 350,
                    "pcm_s16le_base64": pcm_base64(100),
                }
            )
        )
        self.assertIsInstance(command, AudioCommand)
        self.assertEqual((command.start_ms, command.end_ms), (250, 350))
        self.assertEqual(len(command.pcm_s16le), 3_200)

    def test_rejects_malformed_audio_and_unknown_fields(self) -> None:
        with self.assertRaisesRegex(ProtocolError, "does not match"):
            parse_command(
                json.dumps(
                    {
                        "type": "audio",
                        "track": "system",
                        "start_ms": 0,
                        "end_ms": 99,
                        "pcm_s16le_base64": pcm_base64(100),
                    }
                )
            )
        with self.assertRaisesRegex(ProtocolError, "Unknown field"):
            parse_command('{"type":"stop","surprise":true}')
        with self.assertRaisesRegex(ProtocolError, "Invalid JSON"):
            parse_command("{")

    def test_serializes_complementary_partial_and_final_flags(self) -> None:
        segment = SegmentPayload(
            id="session:system:000001",
            revision=2,
            start_ms=0,
            end_ms=200,
            track="system",
            text="hello",
            partial=False,
            final=True,
            language="en",
            translated_text="olá",
            translated_language="pt-BR",
        )
        payload = json.loads(serialize_event(segment_event("final_segment", "session-a", segment)))
        self.assertEqual(payload["session_id"], "session-a")
        self.assertTrue(payload["segment"]["final"])
        self.assertFalse(payload["segment"]["partial"])
        self.assertIsNone(payload["segment"]["speaker_id"])
        self.assertEqual(payload["segment"]["translated_text"], "olá")
        self.assertEqual(payload["segment"]["translated_language"], "pt-BR")

        invalid = {
            "type": "final_segment",
            "session_id": "session-a",
            "segment": {"partial": True, "final": True},
        }
        with self.assertRaisesRegex(ProtocolError, "complementary"):
            serialize_event(invalid)

        with self.assertRaisesRegex(ProtocolError, "session_id"):
            serialize_event({"type": "final_segment", "segment": payload["segment"]})

    def test_translation_fields_are_atomic_bounded_and_consistent(self) -> None:
        base = dict(
            id="segment",
            revision=1,
            start_ms=0,
            end_ms=1,
            track="system",
            text="Original",
            partial=False,
            final=True,
            language="en",
        )
        with self.assertRaisesRegex(ValueError, "translated_language must be null"):
            SegmentPayload(**base, translated_text=None, translated_language="pt-BR")
        with self.assertRaisesRegex(ValueError, "pt-BR"):
            SegmentPayload(**base, translated_text="Traduzido", translated_language="pt")
        with self.assertRaisesRegex(ValueError, "bounded string"):
            SegmentPayload(**base, translated_text="x" * 20_001, translated_language="pt-BR")
        with self.assertRaisesRegex(ValueError, "bounded string"):
            SegmentPayload(**{**base, "text": None})  # type: ignore[arg-type]
        with self.assertRaisesRegex(ValueError, "Partial segments"):
            SegmentPayload(
                **{**base, "partial": True, "final": False},
                translated_text="Rascunho traduzido",
                translated_language="pt-BR",
            )

        valid = SegmentPayload(**base, translated_text="Traduzido", translated_language="pt-BR")
        event = segment_event("final_segment", "session", valid)
        self.assertEqual(event["segment"]["text"], "Original")  # type: ignore[index]
        self.assertEqual(event["segment"]["translated_text"], "Traduzido")  # type: ignore[index]

    def test_serializes_revision_scoped_segment_translation_update(self) -> None:
        event = segment_translation_event(
            "session-a",
            "session-a:system:000001",
            3,
            "Texto traduzido",
        )
        payload = json.loads(serialize_event(event))
        self.assertEqual(
            payload,
            {
                "type": "segment_translation",
                "session_id": "session-a",
                "segment_id": "session-a:system:000001",
                "segment_revision": 3,
                "translated_text": "Texto traduzido",
                "translated_language": "pt-BR",
            },
        )

        invalid_events = (
            {**event, "session_id": ""},
            {**event, "segment_id": ""},
            {**event, "segment_revision": True},
            {**event, "segment_revision": -1},
            {**event, "translated_text": ""},
            {**event, "translated_text": "x" * 20_001},
            {**event, "translated_language": "pt"},
        )
        for invalid in invalid_events:
            with self.subTest(invalid=invalid), self.assertRaises(ProtocolError):
                serialize_event(invalid)


if __name__ == "__main__":
    unittest.main()
