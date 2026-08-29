from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from meeting_transcriber import diarization
from meeting_transcriber.diarization import NoOpSpeakerDiarizer, OnlineSpeakerDiarizer
from meeting_transcriber.segmentation import InferenceJob
from tests.helpers import pcm


def job(
    segment_id: str,
    revision: int,
    *,
    final: bool,
    track: str = "system",
    duration_ms: int = 1_000,
) -> InferenceJob:
    return InferenceJob(
        session_id="session",
        segment_id=segment_id,
        revision=revision,
        start_ms=0,
        end_ms=duration_ms,
        track=track,  # type: ignore[arg-type]
        pcm_s16le=pcm(duration_ms),
        final=final,
    )


class FakeStream:
    def __init__(self) -> None:
        self.sample_count = 0
        self.finished = False

    def accept_waveform(self, *, sample_rate: int, waveform: object) -> None:
        if sample_rate != 16_000:
            raise AssertionError("unexpected sample rate")
        self.sample_count = len(waveform)  # type: ignore[arg-type]

    def input_finished(self) -> None:
        self.finished = True


class SequenceExtractor:
    def __init__(self, embeddings: list[list[float]], ready: list[bool] | None = None) -> None:
        self.embeddings = list(embeddings)
        self.ready = list(ready or [True] * len(embeddings))
        self.streams: list[FakeStream] = []
        self.computations = 0

    def create_stream(self) -> FakeStream:
        stream = FakeStream()
        self.streams.append(stream)
        return stream

    def is_ready(self, stream: FakeStream) -> bool:
        self.assert_finished(stream)
        return self.ready.pop(0)

    def compute(self, stream: FakeStream) -> list[float]:
        self.assert_finished(stream)
        self.computations += 1
        return self.embeddings.pop(0)

    @staticmethod
    def assert_finished(stream: FakeStream) -> None:
        if not stream.finished:
            raise AssertionError("stream was not finalized")


class FakeResponse(io.BytesIO):
    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


class DiarizationTests(unittest.TestCase):
    def test_noop_never_assigns_or_retains_audio(self) -> None:
        disabled = NoOpSpeakerDiarizer()
        disabled.prepare()
        disabled.reset("session")
        self.assertIsNone(disabled.assign(job("a", 1, final=True)))
        disabled.close()

    def test_partial_assignment_is_stable_and_final_updates_the_same_cluster(self) -> None:
        extractor = SequenceExtractor(
            [[1.0, 0.0], [0.9, 0.1], [0.95, 0.05], [-1.0, 0.0]]
        )
        online = OnlineSpeakerDiarizer(extractor=extractor, threshold=0.6)
        online.reset("session")

        self.assertEqual(online.assign(job("a", 1, final=False)), "speaker-01")
        self.assertEqual(online.assign(job("a", 2, final=False)), "speaker-01")
        self.assertEqual(extractor.computations, 1)
        self.assertEqual(online.assign(job("a", 3, final=True)), "speaker-01")
        self.assertEqual(online.assign(job("b", 1, final=True)), "speaker-01")
        self.assertEqual(online.assign(job("c", 1, final=True)), "speaker-02")
        self.assertEqual(online.cluster_count, 2)
        self.assertEqual(online.tracked_partial_count, 0)
        self.assertEqual(online.retained_pcm_bytes, 0)

    def test_short_partial_waits_for_enough_audio_and_microphone_is_never_clustered(self) -> None:
        extractor = SequenceExtractor([[1.0, 0.0]], ready=[False, True])
        online = OnlineSpeakerDiarizer(extractor=extractor)
        online.reset("session")

        self.assertIsNone(online.assign(job("short", 1, final=False, duration_ms=100)))
        self.assertEqual(online.assign(job("short", 2, final=True)), "speaker-01")
        self.assertIsNone(online.assign(job("mic", 1, final=True, track="microphone")))
        self.assertEqual(len(extractor.streams), 2)

    def test_cluster_cap_and_session_reset_are_bounded(self) -> None:
        extractor = SequenceExtractor([[1.0, 0.0], [0.0, 1.0], [-1.0, 0.0]])
        online = OnlineSpeakerDiarizer(extractor=extractor, threshold=0.9, max_clusters=2)
        online.reset("first")

        labels = [online.assign(job(name, 1, final=True)) for name in ("a", "b", "c")]
        self.assertEqual(labels[:2], ["speaker-01", "speaker-02"])
        self.assertIn(labels[2], {"speaker-01", "speaker-02"})
        self.assertEqual(online.cluster_count, 2)

        online.reset("second")
        self.assertEqual(online.cluster_count, 0)
        self.assertEqual(online.tracked_partial_count, 0)
        self.assertEqual(online.retained_pcm_bytes, 0)

    def test_untracked_partial_is_omitted_instead_of_getting_an_unstable_label(self) -> None:
        extractor = SequenceExtractor([[1.0, 0.0], [0.0, 1.0]])
        online = OnlineSpeakerDiarizer(extractor=extractor, threshold=0.9)
        online.reset("session")
        with patch.object(diarization, "MAX_TRACKED_PARTIALS", 1):
            self.assertEqual(online.assign(job("tracked", 1, final=False)), "speaker-01")
            self.assertIsNone(online.assign(job("deferred", 1, final=False)))
            self.assertEqual(online.assign(job("deferred", 2, final=True)), "speaker-02")
        self.assertEqual(extractor.computations, 2)

    def test_verified_download_is_atomic_and_rejects_oversize_or_corrupt_files(self) -> None:
        data = b"verified-test-model"
        digest = hashlib.sha256(data).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "nested" / diarization.MODEL_FILENAME
            with (
                patch.object(diarization, "MODEL_SIZE_BYTES", len(data)),
                patch.object(diarization, "MODEL_SHA256", digest),
            ):
                result = diarization.ensure_model(
                    target,
                    opener=lambda *_args, **_kwargs: FakeResponse(data),
                )
                self.assertEqual(result, target)
                self.assertEqual(target.read_bytes(), data)
                self.assertEqual(list(target.parent.glob("*.tmp")), [])

                target.write_bytes(b"x" * len(data))
                with self.assertRaisesRegex(ValueError, "integrity"):
                    diarization.ensure_model(
                        target,
                        opener=lambda *_args, **_kwargs: self.fail("must not download over an existing file"),
                    )

                target.unlink()
                with self.assertRaisesRegex(ValueError, "size cap"):
                    diarization.ensure_model(
                        target,
                        opener=lambda *_args, **_kwargs: FakeResponse(data + b"x"),
                    )
                self.assertFalse(target.exists())
                self.assertEqual(list(target.parent.glob("*.tmp")), [])

    def test_stale_download_cleanup_is_scoped_and_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old_paths = [
                root / f".{diarization.MODEL_FILENAME}.{index}.tmp"
                for index in range(3)
            ]
            fresh_path = root / f".{diarization.MODEL_FILENAME}.fresh.tmp"
            unrelated_path = root / ".another-model.old.tmp"
            for path in [*old_paths, fresh_path, unrelated_path]:
                path.write_bytes(b"partial")

            now = time.time()
            old_time = now - diarization.STALE_DOWNLOAD_AGE_SECONDS - 1
            for path in [*old_paths, unrelated_path]:
                os.utime(path, (old_time, old_time))

            with patch.object(diarization, "MAX_STALE_DOWNLOADS_TO_REMOVE", 2):
                diarization._cleanup_stale_model_downloads(root, now=now)

            self.assertEqual(sum(path.exists() for path in old_paths), 1)
            self.assertTrue(fresh_path.exists())
            self.assertTrue(unrelated_path.exists())


if __name__ == "__main__":
    unittest.main()
