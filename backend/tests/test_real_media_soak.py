from __future__ import annotations

import io
from pathlib import Path
import subprocess
import unittest

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
                "untranslated_nonempty_finals": 0,
                "empty_final_translation_violations": 0,
                "translated_partial_violations": 0,
                "malformed_event_count": 0,
                "final_latency": {"p95_ms": 6_828.0, "max_ms": 20_022.0},
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

    def test_event_summary_counts_translation_without_retaining_text(self) -> None:
        summary = EventSummary(duration_seconds=3_600)
        summary.set_audio_origin(summary.started_at)
        summary.consume_line(
            '{"type":"final_segment","segment":{"end_ms":500,'
            '"text":"TOP SECRET ORIGINAL","translated_text":"TOP SECRET TRANSLATION",'
            '"translated_language":"pt-BR","speaker_id":"speaker-01"}}'
        )

        result = summary.result()

        self.assertEqual(result["nonempty_final_segments"], 1)
        self.assertEqual(result["translated_final_segments"], 1)
        self.assertEqual(result["anonymous_speaker_count"], 1)
        self.assertNotIn("TOP SECRET", repr(result))

    def test_event_summary_rejects_translation_payload_on_empty_final(self) -> None:
        summary = EventSummary(duration_seconds=3_600)
        summary.consume_line(
            '{"type":"final_segment","segment":{"end_ms":500,"text":"",'
            '"translated_text":"unexpected","translated_language":"pt-BR"}}'
        )

        result = summary.result()

        self.assertEqual(result["nonempty_final_segments"], 0)
        self.assertEqual(result["empty_final_translation_violations"], 1)

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
            "warning_codes": {"translation_unavailable": 1, "other": 1},
            "error_codes": {"inference_backpressure": 1},
        }

        self.assertEqual(
            _critical_codes(result),
            {"translation_unavailable", "inference_backpressure"},
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
