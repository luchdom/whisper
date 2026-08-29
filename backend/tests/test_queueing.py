from __future__ import annotations

import unittest

from meeting_transcriber.queueing import CoalescingJobQueue, InferenceBackpressureError
from meeting_transcriber.segmentation import InferenceJob
from tests.helpers import pcm


def job(segment_id: str, revision: int, *, final: bool = False) -> InferenceJob:
    return InferenceJob(
        session_id="session",
        segment_id=segment_id,
        revision=revision,
        start_ms=0,
        end_ms=revision * 100,
        track="system",
        pcm_s16le=pcm(100),
        final=final,
    )


class QueueingTests(unittest.TestCase):
    def test_coalesces_stale_partial_for_same_segment(self) -> None:
        queue = CoalescingJobQueue(max_pending_partials=2)
        queue.put(job("a", 1))
        queue.put(job("a", 2))
        self.assertEqual([(item.segment_id, item.revision) for item in queue.pending_snapshot()], [("a", 2)])

    def test_partial_capacity_drops_only_partials_and_finals_are_preserved(self) -> None:
        queue = CoalescingJobQueue(max_pending_partials=1)
        queue.put(job("final-a", 1, final=True))
        queue.put(job("partial-a", 1))
        queue.put(job("partial-b", 1))
        snapshot = queue.pending_snapshot()
        self.assertEqual([(item.segment_id, item.final) for item in snapshot], [("final-a", True), ("partial-b", False)])

        queue.put(job("partial-b", 2, final=True))
        snapshot = queue.pending_snapshot()
        self.assertEqual([(item.segment_id, item.final) for item in snapshot], [("final-a", True), ("partial-b", True)])

    def test_pcm_budget_counts_active_and_queued_and_releases_dropped_partials(self) -> None:
        packet_bytes = len(job("size", 1).pcm_s16le)
        queue = CoalescingJobQueue(max_pending_partials=2, max_buffered_pcm_bytes=packet_bytes * 2)
        queue.put(job("active", 1))
        active = queue.get()
        assert active is not None
        self.assertEqual(queue.active_pcm_bytes, packet_bytes)
        self.assertEqual(queue.queued_pcm_bytes, 0)

        queue.put(job("stale", 1))
        self.assertEqual(queue.buffered_pcm_bytes, packet_bytes * 2)
        queue.put(job("replacement", 1))
        self.assertEqual([item.segment_id for item in queue.pending_snapshot()], ["replacement"])
        self.assertEqual(queue.buffered_pcm_bytes, packet_bytes * 2)

        queue.put(job("required-final", 1, final=True))
        self.assertEqual([item.segment_id for item in queue.pending_snapshot()], ["required-final"])
        self.assertEqual(queue.buffered_pcm_bytes, packet_bytes * 2)
        with self.assertRaises(InferenceBackpressureError):
            queue.put(job("cannot-fit-final", 1, final=True))
        self.assertEqual([item.segment_id for item in queue.pending_snapshot()], ["required-final"])
        self.assertLessEqual(queue.buffered_pcm_bytes, queue.max_buffered_pcm_bytes)

        queue.task_done(active)
        self.assertEqual(queue.active_pcm_bytes, 0)
        queued_final = queue.get()
        assert queued_final is not None
        queue.task_done(queued_final)
        self.assertEqual(queue.buffered_pcm_bytes, 0)

    def test_oversized_partial_is_dropped_but_oversized_final_is_explicit(self) -> None:
        packet_bytes = len(job("size", 1).pcm_s16le)
        queue = CoalescingJobQueue(max_buffered_pcm_bytes=packet_bytes - 1)
        self.assertFalse(queue.put(job("partial", 1)))
        self.assertEqual(queue.buffered_pcm_bytes, 0)
        with self.assertRaises(InferenceBackpressureError):
            queue.put(job("final", 1, final=True))
        self.assertEqual(queue.buffered_pcm_bytes, 0)


if __name__ == "__main__":
    unittest.main()
