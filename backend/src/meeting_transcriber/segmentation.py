"""Small deterministic VAD/utterance segmenter for a real-time MVP."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Iterable

from .audio import rms_level
from .protocol import Track


class SegmentationError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class SegmentationConfig:
    vad_rms_threshold: float = 350.0
    pre_roll_ms: int = 240
    silence_finalize_ms: int = 650
    partial_interval_ms: int = 700
    max_utterance_ms: int = 15_000

    def __post_init__(self) -> None:
        if self.vad_rms_threshold < 0:
            raise ValueError("vad_rms_threshold must be non-negative")
        for name in ("pre_roll_ms", "silence_finalize_ms", "partial_interval_ms", "max_utterance_ms"):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive")


@dataclass(frozen=True, slots=True)
class AudioChunk:
    start_ms: int
    end_ms: int
    pcm_s16le: bytes


@dataclass(frozen=True, slots=True)
class InferenceJob:
    session_id: str
    segment_id: str
    revision: int
    start_ms: int
    end_ms: int
    track: Track
    pcm_s16le: bytes
    final: bool

    @property
    def partial(self) -> bool:
        return not self.final


@dataclass(slots=True)
class _TrackState:
    pre_roll: deque[AudioChunk] = field(default_factory=deque)
    active_chunks: list[AudioChunk] = field(default_factory=list)
    segment_id: str | None = None
    segment_start_ms: int | None = None
    last_voice_end_ms: int | None = None
    last_packet_end_ms: int | None = None
    next_partial_at_ms: int | None = None
    revision: int = 0
    utterance_number: int = 0

    @property
    def active(self) -> bool:
        return self.segment_id is not None


class UtteranceSegmenter:
    """Packet-level energy VAD with independent state for each capture track."""

    def __init__(self, session_id: str, config: SegmentationConfig | None = None) -> None:
        self.session_id = session_id
        self.config = config or SegmentationConfig()
        self._states: dict[Track, _TrackState] = {
            "system": _TrackState(),
            "microphone": _TrackState(),
        }

    def process(
        self,
        *,
        track: Track,
        start_ms: int,
        end_ms: int,
        pcm_s16le: bytes,
    ) -> list[InferenceJob]:
        if end_ms <= start_ms:
            raise SegmentationError("Audio packet end_ms must be greater than start_ms")
        state = self._states[track]
        if state.last_packet_end_ms is not None and start_ms < state.last_packet_end_ms:
            raise SegmentationError(f"Audio timing for {track} must be monotonic and non-overlapping")

        jobs: list[InferenceJob] = []
        if state.last_packet_end_ms is not None:
            gap_ms = start_ms - state.last_packet_end_ms
            if state.active and gap_ms >= self.config.silence_finalize_ms:
                jobs.append(self._finalize(state, state.last_packet_end_ms))
            elif not state.active and gap_ms > self.config.pre_roll_ms:
                state.pre_roll.clear()

        chunk = AudioChunk(start_ms=start_ms, end_ms=end_ms, pcm_s16le=pcm_s16le)
        voiced = rms_level(pcm_s16le) >= self.config.vad_rms_threshold
        state.last_packet_end_ms = end_ms

        if not state.active:
            self._append_pre_roll(state, chunk)
            if not voiced:
                return jobs
            self._start_utterance(state, track, end_ms)
        else:
            state.active_chunks.append(chunk)

        if voiced:
            state.last_voice_end_ms = end_ms

        assert state.segment_start_ms is not None
        assert state.last_voice_end_ms is not None
        silence_ms = end_ms - state.last_voice_end_ms
        utterance_ms = end_ms - state.segment_start_ms

        if silence_ms >= self.config.silence_finalize_ms or utterance_ms >= self.config.max_utterance_ms:
            jobs.append(self._finalize(state, end_ms))
        elif state.next_partial_at_ms is not None and end_ms >= state.next_partial_at_ms:
            jobs.append(self._make_job(state, end_ms, final=False))
            while state.next_partial_at_ms <= end_ms:
                state.next_partial_at_ms += self.config.partial_interval_ms
        return jobs

    def flush(self) -> list[InferenceJob]:
        jobs: list[InferenceJob] = []
        for track in ("system", "microphone"):
            state = self._states[track]
            if state.active:
                assert state.last_packet_end_ms is not None
                jobs.append(self._finalize(state, state.last_packet_end_ms))
            state.pre_roll.clear()
        return jobs

    def _append_pre_roll(self, state: _TrackState, chunk: AudioChunk) -> None:
        state.pre_roll.append(chunk)
        # Keep at least the newest packet even when one protocol-valid packet is
        # longer than the configured pre-roll window. Dropping that only packet
        # would make a voiced utterance start from an empty chunk list.
        while len(state.pre_roll) > 1 and chunk.end_ms - state.pre_roll[0].start_ms > self.config.pre_roll_ms:
            state.pre_roll.popleft()

    def _start_utterance(self, state: _TrackState, track: Track, current_end_ms: int) -> None:
        state.utterance_number += 1
        state.segment_id = f"{self.session_id}:{track}:{state.utterance_number:06d}"
        state.active_chunks = list(state.pre_roll)
        state.pre_roll.clear()
        state.segment_start_ms = state.active_chunks[0].start_ms
        state.last_voice_end_ms = current_end_ms
        state.next_partial_at_ms = state.segment_start_ms + self.config.partial_interval_ms
        state.revision = 0

    def _make_job(self, state: _TrackState, end_ms: int, *, final: bool) -> InferenceJob:
        assert state.segment_id is not None
        assert state.segment_start_ms is not None
        state.revision += 1
        return InferenceJob(
            session_id=self.session_id,
            segment_id=state.segment_id,
            revision=state.revision,
            start_ms=state.segment_start_ms,
            end_ms=end_ms,
            track=_track_from_segment_id(state.segment_id),
            pcm_s16le=b"".join(chunk.pcm_s16le for chunk in state.active_chunks),
            final=final,
        )

    def _finalize(self, state: _TrackState, end_ms: int) -> InferenceJob:
        job = self._make_job(state, end_ms, final=True)
        state.active_chunks = []
        state.segment_id = None
        state.segment_start_ms = None
        state.last_voice_end_ms = None
        state.next_partial_at_ms = None
        state.revision = 0
        return job


def _track_from_segment_id(segment_id: str) -> Track:
    # The ID is internal and always assembled by _start_utterance.
    track = segment_id.rsplit(":", 2)[-2]
    if track == "system":
        return "system"
    return "microphone"
