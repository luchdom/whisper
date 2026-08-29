"""A bounded-partial queue that never discards final inference jobs."""

from __future__ import annotations

from collections import deque
from threading import Condition
import time

from .segmentation import InferenceJob


DEFAULT_MAX_BUFFERED_PCM_BYTES = 32 * 1024 * 1024


class QueueClosedError(RuntimeError):
    pass


class InferenceBackpressureError(RuntimeError):
    """A required final job could not fit without exceeding the PCM budget."""

    def __init__(self, *, buffered_bytes: int, requested_bytes: int, maximum_bytes: int) -> None:
        super().__init__("The inference PCM buffer reached its configured limit")
        self.buffered_bytes = buffered_bytes
        self.requested_bytes = requested_bytes
        self.maximum_bytes = maximum_bytes


class CoalescingJobQueue:
    """Coalesce stale partial re-decodes while retaining every final job."""

    def __init__(
        self,
        max_pending_partials: int = 2,
        max_buffered_pcm_bytes: int = DEFAULT_MAX_BUFFERED_PCM_BYTES,
    ) -> None:
        if max_pending_partials <= 0:
            raise ValueError("max_pending_partials must be positive")
        if max_buffered_pcm_bytes <= 0:
            raise ValueError("max_buffered_pcm_bytes must be positive")
        self.max_pending_partials = max_pending_partials
        self.max_buffered_pcm_bytes = max_buffered_pcm_bytes
        self._jobs: deque[InferenceJob] = deque()
        self._active = 0
        self._queued_pcm_bytes = 0
        self._active_pcm_bytes = 0
        self._closed = False
        self._condition = Condition()

    def put(self, job: InferenceJob) -> bool:
        with self._condition:
            if self._closed:
                raise QueueClosedError("Inference queue is closed")
            if job.partial:
                if any(item.segment_id == job.segment_id and item.final for item in self._jobs):
                    return False
                self._drop_matching_partials(job.segment_id)
                while self._partial_count() >= self.max_pending_partials:
                    self._drop_oldest_partial()
            else:
                self._drop_matching_partials(job.segment_id)

            requested_bytes = len(job.pcm_s16le)
            while self._buffered_pcm_bytes_unlocked() + requested_bytes > self.max_buffered_pcm_bytes:
                if not self._drop_oldest_partial():
                    break
            if self._buffered_pcm_bytes_unlocked() + requested_bytes > self.max_buffered_pcm_bytes:
                if job.partial:
                    return False
                raise InferenceBackpressureError(
                    buffered_bytes=self._buffered_pcm_bytes_unlocked(),
                    requested_bytes=requested_bytes,
                    maximum_bytes=self.max_buffered_pcm_bytes,
                )
            self._jobs.append(job)
            self._queued_pcm_bytes += requested_bytes
            self._condition.notify()
            return True

    def get(self) -> InferenceJob | None:
        with self._condition:
            while not self._jobs and not self._closed:
                self._condition.wait()
            if not self._jobs:
                return None
            self._active += 1
            job = self._jobs.popleft()
            job_bytes = len(job.pcm_s16le)
            self._queued_pcm_bytes -= job_bytes
            self._active_pcm_bytes += job_bytes
            return job

    def task_done(self, job: InferenceJob) -> None:
        with self._condition:
            if self._active <= 0:
                raise ValueError("task_done called without an active job")
            job_bytes = len(job.pcm_s16le)
            if job_bytes > self._active_pcm_bytes:
                raise ValueError("task_done PCM size exceeds active queue accounting")
            self._active -= 1
            self._active_pcm_bytes -= job_bytes
            if not self._jobs and self._active == 0:
                self._condition.notify_all()

    def join(self, timeout: float | None = None) -> bool:
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._condition:
            while self._jobs or self._active:
                if deadline is None:
                    self._condition.wait()
                    continue
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(remaining)
            return True

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._condition.notify_all()

    def pending_snapshot(self) -> tuple[InferenceJob, ...]:
        with self._condition:
            return tuple(self._jobs)

    @property
    def queued_pcm_bytes(self) -> int:
        with self._condition:
            return self._queued_pcm_bytes

    @property
    def active_pcm_bytes(self) -> int:
        with self._condition:
            return self._active_pcm_bytes

    @property
    def buffered_pcm_bytes(self) -> int:
        with self._condition:
            return self._buffered_pcm_bytes_unlocked()

    def _partial_count(self) -> int:
        return sum(job.partial for job in self._jobs)

    def _drop_oldest_partial(self) -> bool:
        for index, job in enumerate(self._jobs):
            if job.partial:
                self._queued_pcm_bytes -= len(job.pcm_s16le)
                del self._jobs[index]
                return True
        return False

    def _drop_matching_partials(self, segment_id: str) -> None:
        retained: deque[InferenceJob] = deque()
        for job in self._jobs:
            if job.segment_id == segment_id and job.partial:
                self._queued_pcm_bytes -= len(job.pcm_s16le)
            else:
                retained.append(job)
        self._jobs = retained

    def _buffered_pcm_bytes_unlocked(self) -> int:
        return self._queued_pcm_bytes + self._active_pcm_bytes
