from __future__ import annotations

import unittest

from meeting_transcriber.segmentation import SegmentationConfig, SegmentationError, UtteranceSegmenter
from tests.helpers import pcm


class SegmentationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = SegmentationConfig(
            vad_rms_threshold=100,
            pre_roll_ms=200,
            silence_finalize_ms=200,
            partial_interval_ms=250,
            max_utterance_ms=1_000,
        )
        self.segmenter = UtteranceSegmenter("session-a", self.config)

    def feed(self, track: str, start_ms: int, value: int) -> list:
        return self.segmenter.process(
            track=track,  # type: ignore[arg-type]
            start_ms=start_ms,
            end_ms=start_ms + 100,
            pcm_s16le=pcm(100, value),
        )

    def test_pre_roll_partial_silence_final_and_stable_revisions(self) -> None:
        self.assertEqual(self.feed("system", 0, 0), [])
        self.assertEqual(self.feed("system", 100, 1_000), [])
        partials = self.feed("system", 200, 1_000)
        self.assertEqual(len(partials), 1)
        partial = partials[0]
        self.assertFalse(partial.final)
        self.assertEqual(partial.segment_id, "session-a:system:000001")
        self.assertEqual((partial.revision, partial.start_ms, partial.end_ms), (1, 0, 300))
        self.assertEqual(self.feed("system", 300, 0), [])
        finals = self.feed("system", 400, 0)
        self.assertEqual(len(finals), 1)
        final = finals[0]
        self.assertTrue(final.final)
        self.assertEqual(final.segment_id, partial.segment_id)
        self.assertEqual(final.revision, 2)
        self.assertEqual((final.start_ms, final.end_ms), (0, 500))

    def test_tracks_are_independent_and_flush_starts_new_stable_ids(self) -> None:
        self.feed("system", 0, 1_000)
        self.feed("microphone", 0, 1_000)
        first_finals = self.segmenter.flush()
        self.assertEqual(
            [job.segment_id for job in first_finals],
            ["session-a:system:000001", "session-a:microphone:000001"],
        )
        self.feed("system", 100, 1_000)
        second_final = self.segmenter.flush()[0]
        self.assertEqual(second_final.segment_id, "session-a:system:000002")
        self.assertEqual(second_final.revision, 1)

    def test_max_utterance_creates_a_final_bound(self) -> None:
        segmenter = UtteranceSegmenter(
            "bounded",
            SegmentationConfig(
                vad_rms_threshold=100,
                pre_roll_ms=100,
                silence_finalize_ms=500,
                partial_interval_ms=1_000,
                max_utterance_ms=300,
            ),
        )
        jobs = []
        for start in (0, 100, 200):
            jobs.extend(
                segmenter.process(
                    track="system", start_ms=start, end_ms=start + 100, pcm_s16le=pcm(100, 1_000)
                )
            )
        self.assertEqual(len(jobs), 1)
        self.assertTrue(jobs[0].final)
        self.assertEqual(jobs[0].end_ms - jobs[0].start_ms, 300)

    def test_one_voiced_packet_longer_than_pre_roll_starts_safely(self) -> None:
        segmenter = UtteranceSegmenter(
            "long-packet",
            SegmentationConfig(
                vad_rms_threshold=100,
                pre_roll_ms=200,
                silence_finalize_ms=500,
                partial_interval_ms=700,
                max_utterance_ms=2_000,
            ),
        )

        jobs = segmenter.process(
            track="system",
            start_ms=0,
            end_ms=1_000,
            pcm_s16le=pcm(1_000, 1_000),
        )

        self.assertEqual(len(jobs), 1)
        self.assertTrue(jobs[0].partial)
        self.assertEqual(jobs[0].start_ms, 0)
        self.assertEqual(jobs[0].end_ms, 1_000)
        self.assertEqual(jobs[0].pcm_s16le, pcm(1_000, 1_000))

    def test_rejects_non_monotonic_packet_timing(self) -> None:
        self.feed("system", 100, 1_000)
        with self.assertRaisesRegex(SegmentationError, "monotonic"):
            self.segmenter.process(
                track="system", start_ms=150, end_ms=250, pcm_s16le=pcm(100, 1_000)
            )


if __name__ == "__main__":
    unittest.main()
