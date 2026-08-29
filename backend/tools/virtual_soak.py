"""Accelerated virtual-audio soak; this is not a real meeting validation."""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass
import json
import threading
import tracemalloc

from meeting_transcriber.engine import EngineSettings, TranscriptionResult
from meeting_transcriber.protocol import AudioCommand
from meeting_transcriber.segmentation import SegmentationConfig
from meeting_transcriber.service import TranscriptionService


@dataclass(frozen=True, slots=True)
class SoakMetrics:
    simulation: str
    virtual_minutes: int
    packets_sent: int
    inference_jobs: int
    transcript_events: int
    queue_drain_checkpoints: int
    queue_drained: bool
    final_buffered_pcm_bytes: int
    peak_buffered_pcm_bytes: int
    pcm_budget_bytes: int
    traced_current_bytes: int
    traced_peak_bytes: int


class CountingEngine:
    """Fast fake inference that counts calls and never retains jobs or PCM."""

    def __init__(self) -> None:
        self.settings = EngineSettings()
        self.calls = 0

    def configure(self, settings: EngineSettings) -> None:
        self.settings = settings

    def prepare(self) -> None:
        return

    def transcribe(self, job, language):  # type: ignore[no-untyped-def]
        self.calls += 1
        return TranscriptionResult(text="virtual speech", language=language or "en")

    def close(self) -> None:
        return


class CountingSink:
    """Count protocol event kinds without retaining event dictionaries."""

    def __init__(self) -> None:
        self.counts: Counter[str] = Counter()
        self._lock = threading.Lock()

    def __call__(self, event: dict[str, object]) -> None:
        with self._lock:
            self.counts[str(event["type"])] += 1


def run_virtual_soak(virtual_minutes: int = 60) -> SoakMetrics:
    if virtual_minutes <= 0:
        raise ValueError("virtual_minutes must be positive")
    trace_owned = not tracemalloc.is_tracing()
    if trace_owned:
        tracemalloc.start()
    baseline_current, _ = tracemalloc.get_traced_memory()

    sink = CountingSink()
    engine = CountingEngine()
    pcm_budget = 32 * 1024 * 1024
    service = TranscriptionService(
        engine,
        sink,
        segmentation_config=SegmentationConfig(
            vad_rms_threshold=100,
            pre_roll_ms=5_000,
            silence_finalize_ms=5_000,
            partial_interval_ms=2_500,
            max_utterance_ms=5_000,
        ),
        session_id_factory=lambda: "virtual-soak",
        max_inference_pcm_bytes=pcm_budget,
    )
    # Each small carrier packet advances five seconds of virtual time. This keeps
    # the harness accelerated; it intentionally does not model real-time PCM cost.
    voiced = (1_000).to_bytes(2, "little", signed=True) * 1_600
    silence = bytes(3_200)
    packets_sent = 0
    peak_buffered = 0
    drain_checkpoints = 0

    try:
        service.start({"language": "en", "diarization": "off"})
        for minute in range(virtual_minutes):
            minute_start_ms = minute * 60_000
            for packet_index in range(12):
                start_ms = minute_start_ms + packet_index * 5_000
                packet = voiced if packet_index % 2 == 0 else silence
                service.audio(AudioCommand("system", start_ms, start_ms + 5_000, packet))
                packets_sent += 1
                peak_buffered = max(peak_buffered, service.queue.buffered_pcm_bytes)
            if (minute + 1) % 10 == 0 or minute + 1 == virtual_minutes:
                if not service.queue.join(timeout=10):
                    raise TimeoutError("Virtual soak inference queue did not drain at a checkpoint")
                drain_checkpoints += 1
        service.stop()
        final_buffered = service.queue.buffered_pcm_bytes
        queue_drained = final_buffered == 0
    finally:
        service.shutdown()

    current, traced_peak = tracemalloc.get_traced_memory()
    metrics = SoakMetrics(
        simulation="accelerated_virtual_audio_not_a_real_meeting",
        virtual_minutes=virtual_minutes,
        packets_sent=packets_sent,
        inference_jobs=engine.calls,
        transcript_events=sink.counts["partial_transcript"] + sink.counts["final_segment"],
        queue_drain_checkpoints=drain_checkpoints,
        queue_drained=queue_drained,
        final_buffered_pcm_bytes=final_buffered,
        peak_buffered_pcm_bytes=peak_buffered,
        pcm_budget_bytes=pcm_budget,
        traced_current_bytes=max(0, current - baseline_current),
        traced_peak_bytes=traced_peak,
    )
    if trace_owned:
        tracemalloc.stop()
    return metrics


if __name__ == "__main__":
    print(json.dumps(asdict(run_virtual_soak()), sort_keys=True))
