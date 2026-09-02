from __future__ import annotations

import io
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from tools.real_media_soak import (
    EventSummary,
    _acceptance_failures,
    _build_ffmpeg_command,
    _critical_codes,
    _latency_summary,
    _percentile,
    _read_exact,
    _safe_failure_code,
)


class FragmentedReader(io.BytesIO):
    def read(self, size: int = -1) -> bytes:
        return super().read(min(size, 7))


class RealMediaSoakHelperTests(unittest.TestCase):
    @staticmethod
    def passing_release_result() -> dict[str, object]:
        return {
            "failure": None,
            "packets_sent": 18_000,
            "packets_expected": 18_000,
            "ffmpeg_exit_code": 0,
            "sidecar_exit_code": 0,
            "shutdown_received": True,
            "sidecar_stderr_line_count": 0,
            "ffmpeg_stderr_line_count": 0,
            "critical_codes": [],
            "expected_feed_seconds": 3_599.8,
            "wall_clock_audio_seconds": 3_599.8,
            "send_drift_p95_ms": 12.0,
            "send_drift_max_ms": 78.0,
            "events": {
                "stop_reason": "stopped",
                "nonempty_final_segments": 288,
                "translated_final_segments": 288,
                "untranslated_nonempty_finals": 0,
                "inline_final_translation_violations": 0,
                "empty_final_translation_violations": 0,
                "translated_partial_violations": 0,
                "orphan_translation_update_violations": 0,
                "translation_revision_mismatch_violations": 0,
                "duplicate_translation_update_violations": 0,
                "empty_translation_update_violations": 0,
                "post_stop_translation_update_violations": 0,
                "malformed_event_count": 0,
                "final_latency": {"p95_ms": 6_828.0, "max_ms": 20_022.0},
                "translation_completion_latency": {
                    "p95_ms": 9_100.0,
                    "max_ms": 25_000.0,
                },
                "translation_delay_after_final": {
                    "p95_ms": 2_272.0,
                    "max_ms": 4_978.0,
                },
            },
            "memory": {
                "available": True,
                "sample_count": 716,
                "first_stable_window_sample_count": 120,
                "last_stable_window_sample_count": 120,
                "private_stable_window_delta_mib": -53.2,
            },
        }

    def test_exact_reader_accumulates_fragmented_reads_and_reports_truncation(self) -> None:
        expected = bytes(range(32))

        self.assertEqual(_read_exact(FragmentedReader(expected), len(expected)), expected)
        self.assertEqual(_read_exact(io.BytesIO(b"short"), 10), b"short")

    def test_percentile_and_latency_summary_are_deterministic(self) -> None:
        self.assertEqual(_percentile([0.0, 10.0, 20.0], 0.50), 10.0)
        self.assertEqual(_percentile([0.0, 10.0], 0.95), 10.0)
        self.assertEqual(
            _latency_summary([0.1, 0.2, 0.3]),
            {"count": 3, "p50_ms": 200.0, "p95_ms": 300.0, "max_ms": 300.0},
        )

    def test_event_summary_correlates_delayed_translation_without_retaining_text(self) -> None:
        with patch("tools.real_media_soak.time.monotonic", side_effect=[100.0, 101.2, 102.7]):
            summary = EventSummary(duration_seconds=3_600)
            summary.set_audio_origin(100.0)
            summary.consume_line(
                '{"type":"final_segment","session_id":"session-a","segment":{'
                '"id":"segment-a","revision":2,"end_ms":1000,'
                '"text":"TOP SECRET ORIGINAL","translated_text":null,'
                '"translated_language":null,"speaker_id":"speaker-01"}}'
            )

            before_translation = summary.result()
            self.assertEqual(before_translation["translated_final_segments"], 0)
            self.assertEqual(
                before_translation["final_latency"],
                {"count": 1, "p50_ms": 200.0, "p95_ms": 200.0, "max_ms": 200.0},
            )

            summary.consume_line(
                '{"type":"segment_translation","session_id":"session-a",'
                '"segment_id":"segment-a","segment_revision":2,'
                '"translated_text":"TOP SECRET TRANSLATION",'
                '"translated_language":"pt-BR"}'
            )

        result = summary.result()

        self.assertEqual(result["nonempty_final_segments"], 1)
        self.assertEqual(result["translated_final_segments"], 1)
        self.assertEqual(result["untranslated_nonempty_finals"], 0)
        self.assertEqual(result["anonymous_speaker_count"], 1)
        self.assertEqual(
            result["translation_completion_latency"],
            {"count": 1, "p50_ms": 1700.0, "p95_ms": 1700.0, "max_ms": 1700.0},
        )
        self.assertEqual(
            result["translation_delay_after_final"],
            {"count": 1, "p50_ms": 1500.0, "p95_ms": 1500.0, "max_ms": 1500.0},
        )
        self.assertNotIn("TOP SECRET", repr(result))

    def test_event_summary_detects_invalid_translation_correlations(self) -> None:
        summary = EventSummary(duration_seconds=3_600)
        summary.consume_line(
            '{"type":"segment_translation","session_id":"session-a",'
            '"segment_id":"orphan","segment_revision":1,'
            '"translated_text":"orphan translation","translated_language":"pt-BR"}'
        )
        summary.consume_line(
            '{"type":"final_segment","session_id":"session-a","segment":{'
            '"id":"segment-a","revision":2,"end_ms":500,"text":"original",'
            '"translated_text":null,"translated_language":null}}'
        )
        summary.consume_line(
            '{"type":"segment_translation","session_id":"session-a",'
            '"segment_id":"segment-a","segment_revision":1,'
            '"translated_text":"wrong revision","translated_language":"pt-BR"}'
        )
        valid_update = (
            '{"type":"segment_translation","session_id":"session-a",'
            '"segment_id":"segment-a","segment_revision":2,'
            '"translated_text":"translated","translated_language":"pt-BR"}'
        )
        summary.consume_line(valid_update)
        summary.consume_line(valid_update)
        summary.consume_line(
            '{"type":"final_segment","session_id":"session-a","segment":{'
            '"id":"segment-b","revision":1,"end_ms":800,"text":"original",'
            '"translated_text":null,"translated_language":null}}'
        )
        summary.consume_line(
            '{"type":"segment_translation","session_id":"session-a",'
            '"segment_id":"segment-b","segment_revision":1,'
            '"translated_text":"   ","translated_language":"pt-BR"}'
        )
        summary.consume_line(
            '{"type":"final_segment","session_id":"session-a","segment":{'
            '"id":"segment-c","revision":1,"end_ms":900,"text":"original",'
            '"translated_text":null,"translated_language":null}}'
        )
        summary.consume_line(
            '{"type":"session_stopped","session_id":"session-a","reason":"stopped"}'
        )
        summary.consume_line(
            '{"type":"segment_translation","session_id":"session-a",'
            '"segment_id":"segment-c","segment_revision":1,'
            '"translated_text":"too late","translated_language":"pt-BR"}'
        )

        result = summary.result()

        self.assertEqual(result["translated_final_segments"], 1)
        self.assertEqual(result["orphan_translation_update_violations"], 1)
        self.assertEqual(result["translation_revision_mismatch_violations"], 1)
        self.assertEqual(result["duplicate_translation_update_violations"], 1)
        self.assertEqual(result["empty_translation_update_violations"], 1)
        self.assertEqual(result["post_stop_translation_update_violations"], 1)
        self.assertNotIn("orphan translation", repr(result))
        self.assertNotIn("wrong revision", repr(result))
        self.assertNotIn("too late", repr(result))

    def test_event_summary_rejects_inline_or_empty_final_translation(self) -> None:
        summary = EventSummary(duration_seconds=3_600)
        summary.consume_line(
            '{"type":"final_segment","session_id":"session-a","segment":{'
            '"id":"segment-a","revision":1,"end_ms":500,"text":"original",'
            '"translated_text":"inline","translated_language":"pt-BR"}}'
        )
        summary.consume_line(
            '{"type":"final_segment","session_id":"session-a","segment":{'
            '"id":"segment-b","revision":1,"end_ms":500,"text":"",'
            '"translated_text":"unexpected","translated_language":"pt-BR"}}'
        )
        summary.consume_line(
            '{"type":"segment_translation","session_id":"session-a",'
            '"segment_id":"segment-b","segment_revision":1,'
            '"translated_text":"unexpected update","translated_language":"pt-BR"}'
        )

        result = summary.result()

        self.assertEqual(result["inline_final_translation_violations"], 1)
        self.assertEqual(result["empty_final_translation_violations"], 2)
        self.assertEqual(result["translated_final_segments"], 0)

    def test_release_acceptance_requires_complete_shutdown_memory_and_pacing(self) -> None:
        passing = self.passing_release_result()
        self.assertEqual(_acceptance_failures(passing, release_soak=True), [])

        missing_memory = self.passing_release_result()
        missing_memory["memory"] = {"available": False, "sample_count": 0}
        self.assertEqual(
            set(_acceptance_failures(missing_memory, release_soak=True)),
            {
                "memory_sampling_unavailable",
                "memory_sample_count_insufficient",
                "memory_first_window_insufficient",
                "memory_last_window_insufficient",
                "memory_stable_delta_missing",
            },
        )

        dirty_shutdown = self.passing_release_result()
        dirty_shutdown.update(
            {
                "sidecar_exit_code": 1,
                "shutdown_received": False,
                "sidecar_stderr_line_count": 1,
            }
        )
        self.assertEqual(
            set(_acceptance_failures(dirty_shutdown, release_soak=True)),
            {
                "sidecar_exit_nonzero",
                "sidecar_shutdown_missing",
                "sidecar_stderr_not_empty",
            },
        )

        delayed = self.passing_release_result()
        delayed.update(
            {
                "wall_clock_audio_seconds": 3_620.0,
                "send_drift_p95_ms": 500.0,
                "send_drift_max_ms": 3_000.0,
            }
        )
        delayed_events = dict(delayed["events"])  # type: ignore[arg-type]
        delayed_events["final_latency"] = {"p95_ms": 20_000.0, "max_ms": 70_000.0}
        delayed["events"] = delayed_events
        self.assertEqual(
            set(_acceptance_failures(delayed, release_soak=True)),
            {
                "wall_clock_pacing_exceeded",
                "send_drift_p95_exceeded",
                "send_drift_max_exceeded",
                "final_latency_p95_exceeded",
                "final_latency_max_exceeded",
            },
        )

        invalid_updates = self.passing_release_result()
        invalid_events = dict(invalid_updates["events"])  # type: ignore[arg-type]
        invalid_events.update(
            {
                "untranslated_nonempty_finals": 1,
                "translated_final_segments": 287,
                "inline_final_translation_violations": 1,
                "empty_final_translation_violations": 1,
                "translated_partial_violations": 1,
                "orphan_translation_update_violations": 1,
                "translation_revision_mismatch_violations": 1,
                "duplicate_translation_update_violations": 1,
                "empty_translation_update_violations": 1,
                "post_stop_translation_update_violations": 1,
            }
        )
        invalid_updates["events"] = invalid_events
        self.assertEqual(
            set(_acceptance_failures(invalid_updates, release_soak=True)),
            {
                "translation_payload_missing",
                "inline_final_translation_present",
                "empty_final_translation_present",
                "partial_translation_present",
                "orphan_translation_update_present",
                "translation_revision_mismatch_present",
                "duplicate_translation_update_present",
                "empty_translation_update_present",
                "post_stop_translation_update_present",
            },
        )

    def test_smoke_scope_does_not_claim_release_memory_evidence(self) -> None:
        smoke = self.passing_release_result()
        smoke["memory"] = {"available": False, "sample_count": 0}

        self.assertEqual(_acceptance_failures(smoke, release_soak=False), [])

    def test_failure_codes_never_serialize_commands_paths_or_provider_text(self) -> None:
        secret_path = "C:/Customers/Secret Merger/board-meeting.webm"
        timeout = subprocess.TimeoutExpired(
            ["ffmpeg", "-i", secret_path],
            30,
        )

        failure_code = _safe_failure_code(timeout)

        self.assertEqual(failure_code, "subprocess_timeout")
        self.assertNotIn(secret_path, failure_code)
        self.assertEqual(_safe_failure_code(RuntimeError(secret_path)), "runtime_error")

    def test_critical_code_filter_uses_only_safe_aggregate_codes(self) -> None:
        result = {
            "warning_codes": {
                "translation_unavailable": 1,
                "translation_backpressure": 1,
                "other": 1,
            },
            "error_codes": {"inference_backpressure": 1},
        }

        self.assertEqual(
            _critical_codes(result),
            {
                "translation_unavailable",
                "translation_backpressure",
                "inference_backpressure",
            },
        )

    def test_zero_start_omits_seek_that_discards_opus_priming_samples(self) -> None:
        command = _build_ffmpeg_command(
            Path("C:/tools/ffmpeg.exe"),
            Path("C:/media/meeting.webm"),
            3_600,
            0,
        )
        offset_command = _build_ffmpeg_command(
            Path("C:/tools/ffmpeg.exe"),
            Path("C:/media/meeting.webm"),
            60,
            120,
        )

        self.assertNotIn("-ss", command)
        self.assertEqual(offset_command[offset_command.index("-ss") + 1], "120")


if __name__ == "__main__":
    unittest.main()
