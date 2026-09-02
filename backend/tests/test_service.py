from __future__ import annotations

import io
import json
import threading
import unittest

from meeting_transcriber.engine import (
    FakeTranscriptionEngine,
    ModelLoadProgress,
    TranscriptionResult,
)
from meeting_transcriber.protocol import AudioCommand
from meeting_transcriber.segmentation import SegmentationConfig
from meeting_transcriber.service import JsonlApplication, TranscriptionService
from meeting_transcriber.translation import NoOpTranslator
from tests.helpers import pcm, pcm_base64


TEST_SEGMENTATION = SegmentationConfig(
    vad_rms_threshold=100,
    pre_roll_ms=100,
    silence_finalize_ms=100,
    partial_interval_ms=1_000,
    max_utterance_ms=2_000,
)

FINAL_EVERY_PACKET = SegmentationConfig(
    vad_rms_threshold=100,
    pre_roll_ms=100,
    silence_finalize_ms=100,
    partial_interval_ms=1_000,
    max_utterance_ms=100,
)


class BlockingFakeEngine(FakeTranscriptionEngine):
    def __init__(self) -> None:
        super().__init__()
        self.inference_started = threading.Event()
        self.release_inference = threading.Event()

    def transcribe(self, job, language):  # type: ignore[no-untyped-def]
        self.inference_started.set()
        if not self.release_inference.wait(timeout=5):
            raise TimeoutError("test inference was not released")
        return super().transcribe(job, language)


class FailFirstFinalEngine(FakeTranscriptionEngine):
    def __init__(self) -> None:
        super().__init__()
        self.failed_final = False

    def transcribe(self, job, language):  # type: ignore[no-untyped-def]
        if job.final and not self.failed_final:
            self.failed_final = True
            raise RuntimeError("synthetic final decode failure")
        return super().transcribe(job, language)


class ProgressFakeEngine(FakeTranscriptionEngine):
    def __init__(self) -> None:
        super().__init__()
        self.progress_sink = None

    def set_progress_sink(self, progress_sink) -> None:  # type: ignore[no-untyped-def]
        self.progress_sink = progress_sink

    def prepare(self) -> None:
        assert self.progress_sink is not None
        self.progress_sink(ModelLoadProgress("checking_cache"))
        self.progress_sink(ModelLoadProgress("initializing"))
        super().prepare()


class LanguageResultEngine(FakeTranscriptionEngine):
    def __init__(
        self,
        *,
        text: str = "Original English",
        language: str | None = "en",
        language_probability: float | None = 0.99,
    ) -> None:
        super().__init__()
        self.text = text
        self.language = language
        self.language_probability = language_probability
        self.inference_called = threading.Event()

    def transcribe(self, job, language):  # type: ignore[no-untyped-def]
        self.calls.append(job)
        self.inference_called.set()
        return TranscriptionResult(
            text=self.text,
            language=self.language,
            language_probability=self.language_probability,
        )


class SequenceLanguageResultEngine(FakeTranscriptionEngine):
    def __init__(self, texts: list[str]) -> None:
        super().__init__()
        self.texts = iter(texts)

    def transcribe(self, job, language):  # type: ignore[no-untyped-def]
        self.calls.append(job)
        return TranscriptionResult(
            text=next(self.texts),
            language="en",
            language_probability=0.99,
        )


class StubTranslator:
    def __init__(
        self,
        *,
        translated_text: str = "Portuguese translation",
        fail_prepare: bool = False,
        fail_translate: bool = False,
    ) -> None:
        self.translated_text = translated_text
        self.fail_prepare = fail_prepare
        self.fail_translate = fail_translate
        self.prepare_calls = 0
        self.translate_calls: list[str] = []
        self.progress_sink = None
        self.close_calls = 0
        self.closed = False

    def set_progress_sink(self, progress_sink) -> None:  # type: ignore[no-untyped-def]
        self.progress_sink = progress_sink

    def prepare(self) -> None:
        self.prepare_calls += 1
        if self.progress_sink is not None:
            self.progress_sink("checking_translation_cache")
            self.progress_sink("initializing_translation")
        if self.fail_prepare:
            raise RuntimeError("C:/private/models/translation failed to initialize")

    def translate(self, text: str) -> str:
        self.translate_calls.append(text)
        if self.fail_translate:
            raise RuntimeError("provider detail and C:/private/audio must not leak")
        return self.translated_text

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True


class BlockingStubTranslator(StubTranslator):
    def __init__(self) -> None:
        super().__init__()
        self.translation_started = threading.Event()
        self.release_translation = threading.Event()
        self._in_flight = 0
        self.max_in_flight = 0
        self._lock = threading.Lock()

    def translate(self, text: str) -> str:
        self.translate_calls.append(text)
        with self._lock:
            self._in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self._in_flight)
        self.translation_started.set()
        try:
            if not self.release_translation.wait(timeout=5):
                raise TimeoutError("test translation was not released")
            return f"Portuguese: {text}"
        finally:
            with self._lock:
                self._in_flight -= 1


class StubDiarizer:
    def __init__(self, *, fail_prepare: bool = False, fail_assign: bool = False) -> None:
        self.fail_prepare = fail_prepare
        self.fail_assign = fail_assign
        self.prepare_calls = 0
        self.assign_calls = 0
        self.reset_sessions: list[str | None] = []

    def prepare(self) -> None:
        self.prepare_calls += 1
        if self.fail_prepare:
            raise RuntimeError("private model path must not leak")

    def reset(self, session_id: str | None) -> None:
        self.reset_sessions.append(session_id)

    def assign(self, job) -> str | None:  # type: ignore[no-untyped-def]
        self.assign_calls += 1
        if self.fail_assign:
            raise RuntimeError("private audio-derived detail must not leak")
        return "speaker-07"

    def close(self) -> None:
        return


class ServiceTests(unittest.TestCase):
    def test_model_progress_is_session_scoped_and_precedes_ready(self) -> None:
        events: list[dict[str, object]] = []
        service = TranscriptionService(
            ProgressFakeEngine(),
            events.append,
            session_id_factory=lambda: "progress-session",
        )

        service.start({"model": "small.en"})
        service.shutdown()

        progress_events = [event for event in events if event["type"] == "model_progress"]
        self.assertEqual(
            [event["phase"] for event in progress_events],
            ["checking_cache", "initializing"],
        )
        self.assertTrue(all(event["session_id"] == "progress-session" for event in progress_events))
        self.assertTrue(all("model" not in event for event in progress_events))
        ready_index = next(
            index
            for index, event in enumerate(events)
            if event["type"] == "engine_status" and event["status"] == "ready"
        )
        self.assertLess(events.index(progress_events[-1]), ready_index)

    def test_stop_flushes_pending_speech_before_session_stopped(self) -> None:
        events: list[dict[str, object]] = []
        engine = FakeTranscriptionEngine()
        service = TranscriptionService(
            engine,
            events.append,
            segmentation_config=TEST_SEGMENTATION,
            session_id_factory=lambda: "stable-session",
        )
        service.start({"language": "pt"})
        service.audio(
            AudioCommand(
                track="microphone",
                start_ms=0,
                end_ms=100,
                pcm_s16le=pcm(100),
            )
        )
        service.stop()
        service.shutdown()

        final_index = next(index for index, event in enumerate(events) if event["type"] == "final_segment")
        stop_index = next(index for index, event in enumerate(events) if event["type"] == "session_stopped")
        self.assertLess(final_index, stop_index)
        segment = events[final_index]["segment"]
        self.assertEqual(events[final_index]["session_id"], "stable-session")
        self.assertEqual(segment["id"], "stable-session:microphone:000001")  # type: ignore[index]
        self.assertEqual(segment["revision"], 1)  # type: ignore[index]
        self.assertTrue(segment["final"])  # type: ignore[index]
        self.assertIsNone(segment["speaker_id"])  # type: ignore[index]

    def test_failed_final_marks_session_incomplete_and_next_session_recovers(self) -> None:
        events: list[dict[str, object]] = []
        session_ids = iter(("incomplete-session", "recovered-session"))
        service = TranscriptionService(
            FailFirstFinalEngine(),
            events.append,
            segmentation_config=TEST_SEGMENTATION,
            session_id_factory=lambda: next(session_ids),
        )

        service.start({})
        service.audio(AudioCommand("system", 0, 100, pcm(100)))
        service.stop()
        first_stop = [event for event in events if event["type"] == "session_stopped"][-1]

        self.assertEqual(first_stop["session_id"], "incomplete-session")
        self.assertEqual(first_stop["reason"], "final_inference_failed")
        inference_errors = [event for event in events if event.get("code") == "inference_failed"]
        self.assertEqual(len(inference_errors), 1)
        self.assertNotIn("synthetic", inference_errors[0]["message"])
        self.assertNotIn("decode", inference_errors[0]["message"])
        self.assertFalse(any(
            event["type"] == "final_segment" and event["session_id"] == "incomplete-session"
            for event in events
        ))

        service.start({})
        service.audio(AudioCommand("system", 0, 100, pcm(100)))
        service.stop()
        service.shutdown()
        second_stop = [event for event in events if event["type"] == "session_stopped"][-1]

        self.assertEqual(second_stop["session_id"], "recovered-session")
        self.assertEqual(second_stop["reason"], "stopped")
        self.assertTrue(any(
            event["type"] == "final_segment" and event["session_id"] == "recovered-session"
            for event in events
        ))

    def test_translation_is_emitted_after_the_original_final_segment(self) -> None:
        events: list[dict[str, object]] = []
        translator = StubTranslator(translated_text="Tradução em português")
        service = TranscriptionService(
            LanguageResultEngine(),
            events.append,
            segmentation_config=SegmentationConfig(
                vad_rms_threshold=100,
                pre_roll_ms=100,
                silence_finalize_ms=100,
                partial_interval_ms=1_000,
                max_utterance_ms=100,
            ),
            session_id_factory=lambda: "translated-session",
            translator_factory=lambda _settings: translator,
        )

        service.start(
            {
                "translation": "en_to_pt_br",
                "translation_model": "C:/app-data/models/translation",
                "language": "auto",
            }
        )
        service.audio(AudioCommand("system", 0, 100, pcm(100)))
        service.stop()
        service.shutdown()

        finals = [event for event in events if event["type"] == "final_segment"]
        self.assertEqual(len(finals), 1)
        segment = finals[0]["segment"]
        self.assertEqual(segment["text"], "Original English")  # type: ignore[index]
        self.assertIsNone(segment["translated_text"])  # type: ignore[index]
        self.assertIsNone(segment["translated_language"])  # type: ignore[index]
        translation = next(event for event in events if event["type"] == "segment_translation")
        self.assertEqual(translation["session_id"], "translated-session")
        self.assertEqual(translation["segment_id"], segment["id"])  # type: ignore[index]
        self.assertEqual(translation["segment_revision"], segment["revision"])  # type: ignore[index]
        self.assertEqual(translation["translated_text"], "Tradução em português")
        self.assertEqual(translation["translated_language"], "pt-BR")
        self.assertLess(events.index(finals[0]), events.index(translation))
        self.assertEqual(translator.translate_calls, ["Original English"])
        ready_index = next(
            index
            for index, event in enumerate(events)
            if event["type"] == "engine_status" and event["status"] == "ready"
        )
        progress = [event for event in events if event["type"] == "model_progress"]
        self.assertEqual(
            [event["phase"] for event in progress],
            ["checking_translation_cache", "initializing_translation"],
        )
        self.assertLess(events.index(progress[-1]), ready_index)

    def test_blocked_translation_does_not_delay_current_or_subsequent_originals(self) -> None:
        events: list[dict[str, object]] = []
        two_originals_emitted = threading.Event()
        translator = BlockingStubTranslator()

        def emit(event: dict[str, object]) -> None:
            events.append(event)
            if len([item for item in events if item["type"] == "final_segment"]) >= 2:
                two_originals_emitted.set()

        service = TranscriptionService(
            SequenceLanguageResultEngine(["First English phrase", "Second English phrase"]),
            emit,
            segmentation_config=FINAL_EVERY_PACKET,
            session_id_factory=lambda: "nonblocking-session",
            translator_factory=lambda _settings: translator,
        )
        try:
            service.start(
                {
                    "translation": "en_to_pt_br",
                    "translation_model": "C:/app-data/models/translation",
                    "language": "en",
                }
            )
            service.audio(AudioCommand("system", 0, 100, pcm(100)))
            self.assertTrue(translator.translation_started.wait(timeout=2))
            service.audio(AudioCommand("system", 100, 200, pcm(100)))
            self.assertTrue(two_originals_emitted.wait(timeout=2))

            finals = [event for event in events if event["type"] == "final_segment"]
            self.assertEqual(
                [event["segment"]["text"] for event in finals],  # type: ignore[index]
                ["First English phrase", "Second English phrase"],
            )
            self.assertTrue(all(event["segment"]["translated_text"] is None for event in finals))  # type: ignore[index]
            self.assertFalse(any(event["type"] == "segment_translation" for event in events))

            translator.release_translation.set()
            service.stop()

            translations = [event for event in events if event["type"] == "segment_translation"]
            self.assertEqual(
                [event["translated_text"] for event in translations],
                [
                    "Portuguese: First English phrase",
                    "Portuguese: Second English phrase",
                ],
            )
            self.assertEqual(translator.max_in_flight, 1)
            stop_index = next(
                index for index, event in enumerate(events) if event["type"] == "session_stopped"
            )
            self.assertTrue(all(events.index(event) < stop_index for event in translations))
        finally:
            translator.release_translation.set()
            service.shutdown()

    def test_flush_waits_for_accepted_translation_before_reporting_flushed(self) -> None:
        events: list[dict[str, object]] = []
        translator = BlockingStubTranslator()
        service = TranscriptionService(
            LanguageResultEngine(),
            events.append,
            segmentation_config=FINAL_EVERY_PACKET,
            session_id_factory=lambda: "flush-session",
            translator_factory=lambda _settings: translator,
        )
        flush_finished = threading.Event()

        def flush() -> None:
            service.flush()
            flush_finished.set()

        try:
            service.start(
                {
                    "translation": "en_to_pt_br",
                    "translation_model": "C:/app-data/models/translation",
                    "language": "en",
                }
            )
            service.audio(AudioCommand("system", 0, 100, pcm(100)))
            self.assertTrue(translator.translation_started.wait(timeout=2))
            flush_thread = threading.Thread(target=flush)
            flush_thread.start()
            self.assertFalse(flush_finished.wait(timeout=0.1))

            translator.release_translation.set()
            self.assertTrue(flush_finished.wait(timeout=2))
            flush_thread.join(timeout=2)

            translation_index = next(
                index for index, event in enumerate(events) if event["type"] == "segment_translation"
            )
            flushed_index = next(
                index
                for index, event in enumerate(events)
                if event["type"] == "engine_status" and event["status"] == "flushed"
            )
            self.assertLess(translation_index, flushed_index)
            service.stop()
        finally:
            translator.release_translation.set()
            service.shutdown()

    def test_translation_backpressure_skips_only_overflow_and_warns_once(self) -> None:
        events: list[dict[str, object]] = []
        four_originals_emitted = threading.Event()
        backpressure_emitted = threading.Event()
        first_batch_translated = threading.Event()
        translator = BlockingStubTranslator()

        def emit(event: dict[str, object]) -> None:
            events.append(event)
            if len([item for item in events if item["type"] == "final_segment"]) >= 4:
                four_originals_emitted.set()
            if event.get("code") == "translation_backpressure":
                backpressure_emitted.set()
            if len([item for item in events if item["type"] == "segment_translation"]) >= 2:
                first_batch_translated.set()

        service = TranscriptionService(
            SequenceLanguageResultEngine(["One", "Two", "Three", "Four", "Five"]),
            emit,
            segmentation_config=FINAL_EVERY_PACKET,
            session_id_factory=lambda: "bounded-translation-session",
            max_pending_translations=1,
            translator_factory=lambda _settings: translator,
        )
        try:
            service.start(
                {
                    "translation": "en_to_pt_br",
                    "translation_model": "C:/app-data/models/translation",
                    "language": "en",
                }
            )
            service.audio(AudioCommand("system", 0, 100, pcm(100)))
            self.assertTrue(translator.translation_started.wait(timeout=2))
            for start_ms in (100, 200, 300):
                service.audio(AudioCommand("system", start_ms, start_ms + 100, pcm(100)))
            self.assertTrue(four_originals_emitted.wait(timeout=2))
            self.assertTrue(backpressure_emitted.wait(timeout=2))
            self.assertFalse(any(event["type"] == "segment_translation" for event in events))

            translator.release_translation.set()
            self.assertTrue(first_batch_translated.wait(timeout=2))
            service.audio(AudioCommand("system", 400, 500, pcm(100)))
            service.stop()

            finals = [event for event in events if event["type"] == "final_segment"]
            self.assertEqual([event["segment"]["text"] for event in finals], ["One", "Two", "Three", "Four", "Five"])  # type: ignore[index]
            warnings = [event for event in events if event.get("code") == "translation_backpressure"]
            self.assertEqual(len(warnings), 1)
            self.assertTrue(warnings[0]["recoverable"])
            self.assertNotIn("One", warnings[0]["message"])
            self.assertNotIn("C:/", warnings[0]["message"])
            translations = [event for event in events if event["type"] == "segment_translation"]
            self.assertEqual(
                [event["translated_text"] for event in translations],
                ["Portuguese: One", "Portuguese: Two", "Portuguese: Five"],
            )
            self.assertEqual(translator.translate_calls, ["One", "Two", "Five"])
            self.assertEqual(translator.max_in_flight, 1)
        finally:
            translator.release_translation.set()
            service.shutdown()

    def test_translation_updates_keep_exact_session_and_final_revision(self) -> None:
        events: list[dict[str, object]] = []
        translator = StubTranslator()
        session_ids = iter(("translation-session-a", "translation-session-b"))
        service = TranscriptionService(
            SequenceLanguageResultEngine(["First session", "Second session"]),
            events.append,
            segmentation_config=FINAL_EVERY_PACKET,
            session_id_factory=lambda: next(session_ids),
            translator_factory=lambda _settings: translator,
        )
        try:
            for expected_session in ("translation-session-a", "translation-session-b"):
                service.start(
                    {
                        "translation": "en_to_pt_br",
                        "translation_model": "C:/app-data/models/translation",
                        "language": "en",
                    }
                )
                service.audio(AudioCommand("system", 0, 100, pcm(100)))
                service.stop()
                session_events = [
                    event for event in events if event.get("session_id") == expected_session
                ]
                final = next(event for event in session_events if event["type"] == "final_segment")
                translation = next(
                    event for event in session_events if event["type"] == "segment_translation"
                )
                self.assertEqual(translation["segment_id"], final["segment"]["id"])  # type: ignore[index]
                self.assertEqual(
                    translation["segment_revision"], final["segment"]["revision"]  # type: ignore[index]
                )
                self.assertLess(events.index(final), events.index(translation))
        finally:
            service.shutdown()

    def test_translation_never_runs_for_partial_segments(self) -> None:
        events: list[dict[str, object]] = []
        translator = StubTranslator()
        engine = LanguageResultEngine()
        service = TranscriptionService(
            engine,
            events.append,
            segmentation_config=SegmentationConfig(
                vad_rms_threshold=100,
                pre_roll_ms=100,
                silence_finalize_ms=500,
                partial_interval_ms=100,
                max_utterance_ms=2_000,
            ),
            session_id_factory=lambda: "partial-session",
            translator_factory=lambda _settings: translator,
        )
        service.start(
            {
                "translation": "en_to_pt_br",
                "translation_model": "C:/app-data/models/translation",
                "language": "en",
            }
        )
        service.audio(AudioCommand("system", 0, 100, pcm(100)))
        self.assertTrue(engine.inference_called.wait(timeout=2))
        service.stop()
        service.shutdown()

        partial = next(event for event in events if event["type"] == "partial_transcript")
        final = next(event for event in events if event["type"] == "final_segment")
        self.assertIsNone(partial["segment"]["translated_text"])  # type: ignore[index]
        self.assertIsNone(partial["segment"]["translated_language"])  # type: ignore[index]
        self.assertIsNone(final["segment"]["translated_text"])  # type: ignore[index]
        translations = [event for event in events if event["type"] == "segment_translation"]
        self.assertEqual(len(translations), 1)
        self.assertEqual(translations[0]["segment_id"], final["segment"]["id"])  # type: ignore[index]
        self.assertEqual(translator.translate_calls, ["Original English"])

    def test_empty_final_does_not_disable_translation_for_later_speech(self) -> None:
        events: list[dict[str, object]] = []
        translator = StubTranslator()
        service = TranscriptionService(
            SequenceLanguageResultEngine(["", "Original English"]),
            events.append,
            segmentation_config=SegmentationConfig(
                vad_rms_threshold=100,
                pre_roll_ms=100,
                silence_finalize_ms=100,
                partial_interval_ms=1_000,
                max_utterance_ms=100,
            ),
            session_id_factory=lambda: "empty-then-speech-session",
            translator_factory=lambda _settings: translator,
        )
        service.start(
            {
                "translation": "en_to_pt_br",
                "translation_model": "C:/app-data/models/translation",
                "language": "en",
            }
        )
        service.audio(AudioCommand("system", 0, 100, pcm(100)))
        service.audio(AudioCommand("system", 100, 200, pcm(100)))
        service.stop()
        service.shutdown()

        finals = [event for event in events if event["type"] == "final_segment"]
        self.assertEqual(len(finals), 2)
        self.assertIsNone(finals[0]["segment"]["translated_text"])  # type: ignore[index]
        self.assertIsNone(finals[1]["segment"]["translated_text"])  # type: ignore[index]
        translations = [event for event in events if event["type"] == "segment_translation"]
        self.assertEqual(len(translations), 1)
        self.assertEqual(translations[0]["segment_id"], finals[1]["segment"]["id"])  # type: ignore[index]
        self.assertEqual(translator.translate_calls, ["Original English"])
        self.assertFalse(any(event.get("code") == "translation_unavailable" for event in events))

    def test_disabling_translation_closes_and_releases_the_loaded_translator(self) -> None:
        events: list[dict[str, object]] = []
        translator = StubTranslator()
        session_ids = iter(("translated-session", "original-only-session"))
        service = TranscriptionService(
            LanguageResultEngine(),
            events.append,
            segmentation_config=SegmentationConfig(
                vad_rms_threshold=100,
                pre_roll_ms=100,
                silence_finalize_ms=100,
                partial_interval_ms=1_000,
                max_utterance_ms=100,
            ),
            session_id_factory=lambda: next(session_ids),
            translator_factory=lambda _settings: translator,
        )

        service.start(
            {
                "translation": "en_to_pt_br",
                "translation_model": "C:/app-data/models/translation",
                "language": "en",
            }
        )
        service.audio(AudioCommand("system", 0, 100, pcm(100)))
        service.stop()

        service.start({"translation": "off"})
        self.assertTrue(translator.closed)
        self.assertEqual(translator.close_calls, 1)
        self.assertIsInstance(service._translator, NoOpTranslator)
        self.assertIsNone(service._translator_key)
        self.assertFalse(service._translation_available)

        service.audio(AudioCommand("system", 0, 100, pcm(100)))
        service.stop()
        service.shutdown()
        service.shutdown()

        finals = [event for event in events if event["type"] == "final_segment"]
        self.assertEqual(len(finals), 2)
        first_segment = finals[0]["segment"]
        second_segment = finals[1]["segment"]
        self.assertIsNone(first_segment["translated_text"])  # type: ignore[index]
        self.assertIsNone(second_segment["translated_text"])  # type: ignore[index]
        self.assertIsNone(second_segment["translated_language"])  # type: ignore[index]
        translations = [event for event in events if event["type"] == "segment_translation"]
        self.assertEqual(len(translations), 1)
        self.assertEqual(translations[0]["session_id"], "translated-session")
        self.assertEqual(translations[0]["segment_id"], first_segment["id"])  # type: ignore[index]
        self.assertEqual(translator.translate_calls, ["Original English"])
        self.assertEqual(translator.close_calls, 1)
        self.assertFalse(any(event.get("code") == "translation_unavailable" for event in events))

    def test_translation_language_eligibility_is_strict(self) -> None:
        service = TranscriptionService(FakeTranscriptionEngine(), lambda _event: None)
        try:
            service.settings = service.settings.updated(
                {"translation": "en_to_pt_br", "language": "auto", "model": "small"}
            )
            eligible_probabilities = (0.80, 0.81, 1.0)
            rejected_probabilities = (None, float("nan"), float("inf"), -0.1, 0.79, 1.01)
            for probability in eligible_probabilities:
                with self.subTest(probability=probability):
                    self.assertTrue(service._translation_is_eligible("en", probability))
            for probability in rejected_probabilities:
                with self.subTest(probability=probability):
                    self.assertFalse(service._translation_is_eligible("en", probability))
            self.assertFalse(service._translation_is_eligible("pt", 1.0))

            service.settings = service.settings.updated({"language": "en"})
            self.assertTrue(service._translation_is_eligible(None, None))
            service.settings = service.settings.updated({"language": "pt", "model": "small.en"})
            self.assertTrue(service._translation_is_eligible(None, None))
        finally:
            service.shutdown()

    def test_translation_prepare_failure_warns_once_and_keeps_original_final(self) -> None:
        events: list[dict[str, object]] = []
        translator = StubTranslator(fail_prepare=True)
        service = TranscriptionService(
            LanguageResultEngine(),
            events.append,
            segmentation_config=SegmentationConfig(
                vad_rms_threshold=100,
                pre_roll_ms=100,
                silence_finalize_ms=100,
                partial_interval_ms=1_000,
                max_utterance_ms=100,
            ),
            session_id_factory=lambda: "translation-prepare-failure",
            translator_factory=lambda _settings: translator,
        )
        service.start(
            {
                "translation": "en_to_pt_br",
                "translation_model": "C:/app-data/models/translation",
                "language": "en",
            }
        )
        service.audio(AudioCommand("system", 0, 100, pcm(100)))
        service.stop()
        service.shutdown()

        warnings = [event for event in events if event.get("code") == "translation_unavailable"]
        self.assertEqual(len(warnings), 1)
        self.assertNotIn("private", warnings[0]["message"])
        self.assertNotIn("C:/", warnings[0]["message"])
        final = next(event for event in events if event["type"] == "final_segment")
        self.assertEqual(final["segment"]["text"], "Original English")  # type: ignore[index]
        self.assertIsNone(final["segment"]["translated_text"])  # type: ignore[index]
        self.assertEqual(
            [event for event in events if event["type"] == "session_stopped"][-1]["reason"],
            "stopped",
        )
        self.assertFalse(any(event.get("code") == "inference_failed" for event in events))

    def test_translation_inference_failure_is_fail_soft_and_warns_at_most_once(self) -> None:
        events: list[dict[str, object]] = []
        translator = StubTranslator(fail_translate=True)
        service = TranscriptionService(
            LanguageResultEngine(),
            events.append,
            segmentation_config=SegmentationConfig(
                vad_rms_threshold=100,
                pre_roll_ms=100,
                silence_finalize_ms=100,
                partial_interval_ms=1_000,
                max_utterance_ms=100,
            ),
            session_id_factory=lambda: "translation-inference-failure",
            translator_factory=lambda _settings: translator,
        )
        service.start(
            {
                "translation": "en_to_pt_br",
                "translation_model": "C:/app-data/models/translation",
                "language": "en",
            }
        )
        service.audio(AudioCommand("system", 0, 100, pcm(100)))
        service.audio(AudioCommand("system", 100, 200, pcm(100)))
        service.stop()
        service.shutdown()

        warnings = [event for event in events if event.get("code") == "translation_unavailable"]
        self.assertEqual(len(warnings), 1)
        self.assertNotIn("provider", warnings[0]["message"])
        self.assertNotIn("private", warnings[0]["message"])
        finals = [event for event in events if event["type"] == "final_segment"]
        self.assertEqual(len(finals), 2)
        self.assertTrue(all(event["segment"]["text"] == "Original English" for event in finals))  # type: ignore[index]
        self.assertTrue(all(event["segment"]["translated_text"] is None for event in finals))  # type: ignore[index]
        self.assertEqual(translator.translate_calls, ["Original English"])
        self.assertFalse(any(event.get("code") == "inference_failed" for event in events))
        self.assertEqual(
            [event for event in events if event["type"] == "session_stopped"][-1]["reason"],
            "stopped",
        )

    def test_jsonl_fake_engine_end_to_end(self) -> None:
        commands = [
            {"type": "configure", "model": "tiny", "language": "en", "device": "cpu", "compute": "int8"},
            {"type": "start"},
            {
                "type": "audio",
                "track": "system",
                "start_ms": 0,
                "end_ms": 100,
                "pcm_s16le_base64": pcm_base64(100),
            },
            {"type": "stop"},
            {"type": "shutdown"},
        ]
        input_stream = io.StringIO("".join(json.dumps(command) + "\n" for command in commands))
        output_stream = io.StringIO()
        app = JsonlApplication(
            FakeTranscriptionEngine(),
            segmentation_config=TEST_SEGMENTATION,
            session_id_factory=lambda: "jsonl-session",
        )
        app.run(input_stream, output_stream)
        events = [json.loads(line) for line in output_stream.getvalue().splitlines()]

        statuses = [event["status"] for event in events if event["type"] == "engine_status"]
        self.assertEqual(statuses[:3], ["configured", "loading", "ready"])
        self.assertEqual(statuses[-1], "shutdown")
        final = next(event for event in events if event["type"] == "final_segment")
        self.assertEqual(final["segment"]["track"], "system")
        self.assertEqual(final["session_id"], "jsonl-session")
        self.assertEqual(final["segment"]["text"], "Meeting audio test speech (100 ms, final)")
        self.assertEqual(final["segment"]["language"], "en")
        self.assertEqual(events[-2]["type"], "session_stopped")

    def test_invalid_json_yields_safe_protocol_error_and_continues(self) -> None:
        output = io.StringIO()
        JsonlApplication(FakeTranscriptionEngine()).run(
            io.StringIO('{not json}\n{"type":"shutdown"}\n'),
            output,
        )
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(events[0]["type"], "error")
        self.assertEqual(events[0]["source"], "protocol")
        self.assertNotIn("not json", events[0]["message"])

    def test_diarization_prepare_failure_warns_once_but_asr_reaches_ready_and_transcribes(self) -> None:
        events: list[dict[str, object]] = []
        diarizer = StubDiarizer(fail_prepare=True)
        service = TranscriptionService(
            FakeTranscriptionEngine(),
            events.append,
            segmentation_config=SegmentationConfig(
                vad_rms_threshold=100,
                pre_roll_ms=100,
                silence_finalize_ms=100,
                partial_interval_ms=1_000,
                max_utterance_ms=100,
            ),
            session_id_factory=lambda: "prepare-failure",
            diarizer_factory=lambda _settings: diarizer,
        )

        service.start({"diarization": "online", "diarization_model": "C:/private/model.onnx"})
        service.audio(AudioCommand("system", 0, 100, pcm(100)))
        service.stop()
        service.shutdown()

        warnings = [event for event in events if event.get("code") == "diarization_unavailable"]
        self.assertEqual(len(warnings), 1)
        self.assertEqual(warnings[0]["type"], "warning")
        self.assertEqual(warnings[0]["source"], "transcription")
        self.assertTrue(warnings[0]["recoverable"])
        self.assertNotIn("private", warnings[0]["message"])
        statuses = [event["status"] for event in events if event["type"] == "engine_status"]
        self.assertIn("ready", statuses)
        self.assertNotIn("unavailable", statuses)
        final = next(event for event in events if event["type"] == "final_segment")
        self.assertIsNone(final["segment"]["speaker_id"])  # type: ignore[index]

    def test_diarization_inference_failure_warns_once_and_every_asr_final_continues(self) -> None:
        events: list[dict[str, object]] = []
        diarizer = StubDiarizer(fail_assign=True)
        service = TranscriptionService(
            FakeTranscriptionEngine(),
            events.append,
            segmentation_config=SegmentationConfig(
                vad_rms_threshold=100,
                pre_roll_ms=100,
                silence_finalize_ms=100,
                partial_interval_ms=1_000,
                max_utterance_ms=100,
            ),
            session_id_factory=lambda: "inference-failure",
            diarizer_factory=lambda _settings: diarizer,
        )

        service.start({"diarization": "online"})
        service.audio(AudioCommand("system", 0, 100, pcm(100)))
        service.audio(AudioCommand("system", 100, 200, pcm(100)))
        service.stop()
        service.shutdown()

        self.assertEqual(len([event for event in events if event.get("code") == "diarization_unavailable"]), 1)
        finals = [event for event in events if event["type"] == "final_segment"]
        self.assertEqual(len(finals), 2)
        self.assertTrue(all(event["segment"]["speaker_id"] is None for event in finals))  # type: ignore[index]
        self.assertEqual(diarizer.assign_calls, 1)
        self.assertFalse(any(event.get("code") == "inference_failed" for event in events))

    def test_online_mode_passes_model_path_and_labels_only_system_track(self) -> None:
        events: list[dict[str, object]] = []
        diarizer = StubDiarizer()
        observed_settings = []

        def factory(settings):  # type: ignore[no-untyped-def]
            observed_settings.append(settings)
            return diarizer

        service = TranscriptionService(
            FakeTranscriptionEngine(),
            events.append,
            segmentation_config=SegmentationConfig(
                vad_rms_threshold=100,
                pre_roll_ms=100,
                silence_finalize_ms=100,
                partial_interval_ms=1_000,
                max_utterance_ms=100,
            ),
            session_id_factory=lambda: "labels",
            diarizer_factory=factory,
        )
        service.start({"diarization": "online", "diarization_model": "C:/models/speaker.onnx"})
        service.audio(AudioCommand("system", 0, 100, pcm(100)))
        service.audio(AudioCommand("microphone", 0, 100, pcm(100)))
        service.stop()
        service.shutdown()

        self.assertEqual(observed_settings[0].diarization_model, "C:/models/speaker.onnx")
        finals = [event for event in events if event["type"] == "final_segment"]
        by_track = {event["segment"]["track"]: event["segment"]["speaker_id"] for event in finals}  # type: ignore[index]
        self.assertEqual(by_track, {"system": "speaker-07", "microphone": None})
        self.assertEqual(diarizer.assign_calls, 1)
        self.assertEqual(diarizer.reset_sessions[0], "labels")

    def test_slow_engine_hits_bounded_pcm_budget_once_and_next_session_recovers(self) -> None:
        events: list[dict[str, object]] = []
        engine = BlockingFakeEngine()
        session_ids = iter(("overloaded-session", "recovered-session"))
        one_packet_bytes = len(pcm(100))
        service = TranscriptionService(
            engine,
            events.append,
            segmentation_config=SegmentationConfig(
                vad_rms_threshold=100,
                pre_roll_ms=100,
                silence_finalize_ms=500,
                partial_interval_ms=1_000,
                max_utterance_ms=100,
            ),
            session_id_factory=lambda: next(session_ids),
            max_inference_pcm_bytes=one_packet_bytes * 2,
        )
        service.start({"language": "pt"})
        service.audio(AudioCommand("system", 0, 100, pcm(100)))
        self.assertTrue(engine.inference_started.wait(timeout=2))
        service.audio(AudioCommand("system", 100, 200, pcm(100)))
        self.assertEqual(service.queue.buffered_pcm_bytes, one_packet_bytes * 2)

        service.audio(AudioCommand("system", 200, 300, pcm(100)))
        overloads = [event for event in events if event.get("code") == "inference_backpressure"]
        self.assertEqual(len(overloads), 1)
        self.assertFalse(overloads[0]["recoverable"])
        self.assertNotIn("segment_id", overloads[0])
        self.assertLessEqual(service.queue.buffered_pcm_bytes, one_packet_bytes * 2)

        for start_ms in range(300, 1_300, 100):
            service.audio(AudioCommand("system", start_ms, start_ms + 100, pcm(100)))
        self.assertEqual(
            len([event for event in events if event.get("code") == "inference_backpressure"]),
            1,
        )
        self.assertEqual(service.queue.buffered_pcm_bytes, one_packet_bytes * 2)

        engine.release_inference.set()
        service.stop()
        first_stop = [event for event in events if event["type"] == "session_stopped"][-1]
        self.assertEqual(first_stop["session_id"], "overloaded-session")
        self.assertEqual(first_stop["reason"], "inference_backpressure")
        self.assertEqual(service.queue.buffered_pcm_bytes, 0)
        first_session_finals = [
            event
            for event in events
            if event["type"] == "final_segment" and event["session_id"] == "overloaded-session"
        ]
        self.assertEqual(len(first_session_finals), 2)

        service.start({})
        service.audio(AudioCommand("microphone", 0, 100, pcm(100)))
        service.stop()
        service.shutdown()
        second_stop = [event for event in events if event["type"] == "session_stopped"][-1]
        self.assertEqual(second_stop["session_id"], "recovered-session")
        self.assertEqual(second_stop["reason"], "stopped")


if __name__ == "__main__":
    unittest.main()
