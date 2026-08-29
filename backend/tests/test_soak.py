from __future__ import annotations

import unittest

from tools.virtual_soak import run_virtual_soak


class VirtualSoakTests(unittest.TestCase):
    def test_sixty_virtual_minutes_drain_with_bounded_counting_state(self) -> None:
        metrics = run_virtual_soak(virtual_minutes=60)

        self.assertEqual(metrics.simulation, "accelerated_virtual_audio_not_a_real_meeting")
        self.assertEqual(metrics.virtual_minutes, 60)
        self.assertEqual(metrics.packets_sent, 720)
        self.assertEqual(metrics.queue_drain_checkpoints, 6)
        self.assertTrue(metrics.queue_drained)
        self.assertEqual(metrics.final_buffered_pcm_bytes, 0)
        self.assertGreater(metrics.inference_jobs, 0)
        self.assertEqual(metrics.transcript_events, metrics.inference_jobs)
        self.assertLessEqual(metrics.peak_buffered_pcm_bytes, metrics.pcm_budget_bytes)
        self.assertLess(metrics.traced_current_bytes, 16 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
