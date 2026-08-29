"""Run a transcript-safe, wall-clock soak through the production JSONL sidecar.

The media is decoded to the desktop audio contract (mono 16 kHz signed
16-bit PCM) and sent in the same 200 ms packet shape as the renderer.  Raw
audio and transcript text are never written by this tool; only aggregate
health metrics are emitted.
"""

from __future__ import annotations

import argparse
import base64
from collections import Counter
import ctypes
from ctypes import wintypes
import json
import math
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import threading
import time
from typing import Any


SAMPLE_RATE_HZ = 16_000
PACKET_MS = 200
PACKET_SAMPLES = SAMPLE_RATE_HZ * PACKET_MS // 1_000
PACKET_BYTES = PACKET_SAMPLES * 2
CRITICAL_CODES = frozenset(
    {
        "audio_gap",
        "engine_initialization_failed",
        "inference_backpressure",
        "inference_failed",
        "non_monotonic_audio",
        "translation_unavailable",
    }
)
MAX_PRIVATE_STABLE_GROWTH_MIB = 256.0
MIN_RELEASE_MEMORY_SAMPLES = 600
MIN_RELEASE_STABLE_WINDOW_SAMPLES = 60
MAX_SEND_DRIFT_P95_MS = 250.0
MAX_SEND_DRIFT_MS = 2_000.0
MAX_FEED_DURATION_ERROR_SECONDS = 5.0
MAX_FINAL_LATENCY_P95_MS = 15_000.0
MAX_FINAL_LATENCY_MS = 60_000.0


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[index]


def _latency_summary(values: list[float]) -> dict[str, float | int | None]:
    return {
        "count": len(values),
        "p50_ms": _rounded_ms(_percentile(values, 0.50)),
        "p95_ms": _rounded_ms(_percentile(values, 0.95)),
        "max_ms": _rounded_ms(max(values) if values else None),
    }


def _rounded_ms(value: float | None) -> float | None:
    return None if value is None else round(value * 1_000, 1)


class EventSummary:
    def __init__(self, duration_seconds: int) -> None:
        self.duration_seconds = duration_seconds
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.unavailable = threading.Event()
        self.stopped = threading.Event()
        self.shutdown = threading.Event()
        self.event_counts: Counter[str] = Counter()
        self.warning_codes: Counter[str] = Counter()
        self.error_codes: Counter[str] = Counter()
        self.model_phases: list[dict[str, object]] = []
        self.partial_count = 0
        self.final_count = 0
        self.nonempty_final_count = 0
        self.translated_final_count = 0
        self.empty_final_translation_violations = 0
        self.translated_partial_count = 0
        self.speaker_ids: set[str] = set()
        self.final_latencies: list[float] = []
        self.first_ten_minute_latencies: list[float] = []
        self.last_ten_minute_latencies: list[float] = []
        self.stop_reason: str | None = None
        self.session_id: str | None = None
        self.started_at = time.monotonic()
        self.ready_at: float | None = None
        self.audio_origin: float | None = None
        self.malformed_event_count = 0

    def set_audio_origin(self, value: float) -> None:
        with self.lock:
            self.audio_origin = value

    def consume_line(self, line: str) -> None:
        try:
            event = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            with self.lock:
                self.malformed_event_count += 1
            return
        if not isinstance(event, dict):
            with self.lock:
                self.malformed_event_count += 1
            return
        event_type = event.get("type")
        if not isinstance(event_type, str):
            with self.lock:
                self.malformed_event_count += 1
            return

        now = time.monotonic()
        with self.lock:
            self.event_counts[event_type] += 1
            if event_type == "model_progress":
                phase = event.get("phase")
                if isinstance(phase, str):
                    self.model_phases.append(
                        {"phase": phase, "elapsed_seconds": round(now - self.started_at, 3)}
                    )
            elif event_type == "engine_status":
                status = event.get("status")
                if status == "ready":
                    self.ready_at = now
                    session_id = event.get("session_id")
                    if isinstance(session_id, str):
                        self.session_id = session_id
                    self.ready.set()
                elif status == "unavailable":
                    self.unavailable.set()
                elif status == "shutdown":
                    self.shutdown.set()
            elif event_type in {"warning", "error"}:
                code = event.get("code")
                safe_code = code if isinstance(code, str) else "invalid_code"
                target = self.warning_codes if event_type == "warning" else self.error_codes
                target[safe_code] += 1
            elif event_type in {"partial_transcript", "final_segment"}:
                self._consume_segment(event_type, event, now)
            elif event_type == "session_stopped":
                reason = event.get("reason")
                self.stop_reason = reason if isinstance(reason, str) else "invalid_reason"
                self.stopped.set()

    def _consume_segment(self, event_type: str, event: dict[str, Any], received_at: float) -> None:
        segment = event.get("segment")
        if not isinstance(segment, dict):
            self.malformed_event_count += 1
            return
        translated = segment.get("translated_text")
        translated_nonempty = isinstance(translated, str) and bool(translated.strip())
        speaker_id = segment.get("speaker_id")
        if isinstance(speaker_id, str) and speaker_id:
            self.speaker_ids.add(speaker_id)

        if event_type == "partial_transcript":
            self.partial_count += 1
            if translated_nonempty or segment.get("translated_language") is not None:
                self.translated_partial_count += 1
            return

        self.final_count += 1
        text_value = segment.get("text")
        nonempty = isinstance(text_value, str) and bool(text_value.strip())
        if nonempty:
            self.nonempty_final_count += 1
            if translated_nonempty and segment.get("translated_language") == "pt-BR":
                self.translated_final_count += 1
        elif translated_nonempty or segment.get("translated_language") is not None:
            self.empty_final_translation_violations += 1

        end_ms = segment.get("end_ms")
        if self.audio_origin is None or isinstance(end_ms, bool) or not isinstance(end_ms, int):
            return
        latency = received_at - (self.audio_origin + end_ms / 1_000)
        self.final_latencies.append(latency)
        if end_ms <= 600_000:
            self.first_ten_minute_latencies.append(latency)
        if end_ms >= max(0, self.duration_seconds * 1_000 - 600_000):
            self.last_ten_minute_latencies.append(latency)

    def snapshot(self) -> dict[str, object]:
        with self.lock:
            return {
                "partials": self.partial_count,
                "finals": self.final_count,
                "translated_finals": self.translated_final_count,
                "warnings": sum(self.warning_codes.values()),
                "errors": sum(self.error_codes.values()),
            }

    def result(self) -> dict[str, object]:
        with self.lock:
            return {
                "event_counts": dict(sorted(self.event_counts.items())),
                "warning_codes": dict(sorted(self.warning_codes.items())),
                "error_codes": dict(sorted(self.error_codes.items())),
                "model_progress": list(self.model_phases),
                "ready_seconds": (
                    round(self.ready_at - self.started_at, 3) if self.ready_at is not None else None
                ),
                "partial_segments": self.partial_count,
                "final_segments": self.final_count,
                "nonempty_final_segments": self.nonempty_final_count,
                "translated_final_segments": self.translated_final_count,
                "untranslated_nonempty_finals": (
                    self.nonempty_final_count - self.translated_final_count
                ),
                "empty_final_translation_violations": self.empty_final_translation_violations,
                "translated_partial_violations": self.translated_partial_count,
                "anonymous_speaker_count": len(self.speaker_ids),
                "stop_reason": self.stop_reason,
                "malformed_event_count": self.malformed_event_count,
                "final_latency": _latency_summary(self.final_latencies),
                "first_ten_minutes_final_latency": _latency_summary(
                    self.first_ten_minute_latencies
                ),
                "last_ten_minutes_final_latency": _latency_summary(
                    self.last_ten_minute_latencies
                ),
            }


class _ProcessMemoryCountersEx(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("PageFaultCount", wintypes.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
        ("PrivateUsage", ctypes.c_size_t),
    ]


class _ProcessEntry32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]


def _windows_process_tree(root_pid: int) -> set[int]:
    if os.name != "nt":
        return {root_pid}
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ProcessEntry32W)]
    kernel32.Process32FirstW.restype = wintypes.BOOL
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ProcessEntry32W)]
    kernel32.Process32NextW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    snapshot = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    if snapshot == wintypes.HANDLE(-1).value:
        return {root_pid}
    parent_by_pid: dict[int, int] = {}
    try:
        entry = _ProcessEntry32W()
        entry.dwSize = ctypes.sizeof(entry)
        if kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
            while True:
                parent_by_pid[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
                entry.dwSize = ctypes.sizeof(entry)
                if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                    break
    finally:
        kernel32.CloseHandle(snapshot)

    result = {root_pid}
    changed = True
    while changed:
        changed = False
        for pid, parent_pid in parent_by_pid.items():
            if parent_pid in result and pid not in result:
                result.add(pid)
                changed = True
    return result


def _windows_single_process_memory_bytes(pid: int) -> tuple[int, int] | None:
    if os.name != "nt":
        return None
    process_query_limited_information = 0x1000
    process_vm_read = 0x0010
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    psapi.GetProcessMemoryInfo.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(_ProcessMemoryCountersEx),
        wintypes.DWORD,
    ]
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(
        process_query_limited_information | process_vm_read,
        False,
        pid,
    )
    if not handle:
        return None
    try:
        counters = _ProcessMemoryCountersEx()
        counters.cb = ctypes.sizeof(counters)
        ok = psapi.GetProcessMemoryInfo(
            handle,
            ctypes.byref(counters),
            counters.cb,
        )
        if not ok:
            return None
        return int(counters.WorkingSetSize), int(counters.PrivateUsage)
    finally:
        kernel32.CloseHandle(handle)


def _windows_memory_bytes(pid: int) -> tuple[int, int, int] | None:
    samples = [
        values
        for process_id in _windows_process_tree(pid)
        if (values := _windows_single_process_memory_bytes(process_id)) is not None
    ]
    if not samples:
        return None
    return sum(value[0] for value in samples), sum(value[1] for value in samples), len(samples)


class MemorySampler:
    def __init__(self, pid: int, events: EventSummary, interval_seconds: float = 5.0) -> None:
        self.pid = pid
        self.events = events
        self.interval_seconds = interval_seconds
        self.stop_event = threading.Event()
        self.samples: list[tuple[float, int, int, int]] = []
        self.thread = threading.Thread(target=self._run, name="soak-memory-sampler", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=self.interval_seconds + 2)

    def _run(self) -> None:
        while not self.stop_event.is_set():
            values = _windows_memory_bytes(self.pid)
            with self.events.lock:
                origin = self.events.audio_origin
            if values is not None and origin is not None:
                self.samples.append((time.monotonic() - origin, values[0], values[1], values[2]))
            self.stop_event.wait(self.interval_seconds)

    def result(self, duration_seconds: int) -> dict[str, object]:
        if not self.samples:
            return {"sample_count": 0, "available": False}
        working_sets = [sample[1] for sample in self.samples]
        private_sizes = [sample[2] for sample in self.samples]
        process_counts = [sample[3] for sample in self.samples]
        first_window = [
            sample[2] for sample in self.samples if 600 <= sample[0] < min(1_200, duration_seconds)
        ]
        last_window_start = max(600, duration_seconds - 600)
        last_window = [sample[2] for sample in self.samples if sample[0] >= last_window_start]
        first_median = int(statistics.median(first_window)) if first_window else None
        last_median = int(statistics.median(last_window)) if last_window else None
        stable_delta = (
            last_median - first_median
            if first_median is not None and last_median is not None
            else None
        )
        return {
            "available": True,
            "sample_count": len(self.samples),
            "first_stable_window_sample_count": len(first_window),
            "last_stable_window_sample_count": len(last_window),
            "working_set_peak_mib": round(max(working_sets) / (1024 * 1024), 1),
            "private_peak_mib": round(max(private_sizes) / (1024 * 1024), 1),
            "sampled_process_count_max": max(process_counts),
            "private_first_stable_window_median_mib": _mib(first_median),
            "private_last_window_median_mib": _mib(last_median),
            "private_stable_window_delta_mib": _mib(stable_delta),
        }


def _mib(value: int | None) -> float | None:
    return None if value is None else round(value / (1024 * 1024), 1)


def _write_command(process: subprocess.Popen[str], command: dict[str, object]) -> None:
    if process.stdin is None:
        raise RuntimeError("The sidecar input stream is unavailable")
    process.stdin.write(json.dumps(command, separators=(",", ":")) + "\n")
    process.stdin.flush()


def _read_exact(stream: Any, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _reader(process: subprocess.Popen[str], summary: EventSummary) -> None:
    assert process.stdout is not None
    for line in process.stdout:
        summary.consume_line(line)


def _drain_lines(stream: Any, counter: list[int]) -> None:
    for _line in stream:
        counter[0] += 1


def _wait_until(deadline: float) -> None:
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(remaining, 0.05))


def _build_ffmpeg_command(
    ffmpeg_path: Path,
    media: Path,
    duration_seconds: int,
    start_seconds: int,
) -> list[str]:
    command = [str(ffmpeg_path), "-hide_banner", "-loglevel", "error"]
    # Even a nominal input seek of zero can discard codec-priming samples from
    # Opus. Omit it so an exact-hour source yields an exact-hour PCM stream.
    if start_seconds > 0:
        command.extend(("-ss", str(start_seconds)))
    command.extend(
        (
            "-i",
            str(media),
            "-t",
            str(duration_seconds),
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE_HZ),
            "-acodec",
            "pcm_s16le",
            "-f",
            "s16le",
            "pipe:1",
        )
    )
    return command


def _critical_codes(result: dict[str, object]) -> set[str]:
    warning_codes = result.get("warning_codes", {})
    error_codes = result.get("error_codes", {})
    observed = set(warning_codes) | set(error_codes)  # type: ignore[arg-type]
    return observed & CRITICAL_CODES


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _safe_failure_code(exc: Exception) -> str:
    """Classify failures without serializing commands, paths, or provider text."""
    if isinstance(exc, subprocess.TimeoutExpired):
        return "subprocess_timeout"
    if isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, ValueError):
        return "invalid_configuration"
    if isinstance(exc, (BrokenPipeError, OSError)):
        return "io_error"
    if isinstance(exc, RuntimeError):
        return "runtime_error"
    return "unexpected_error"


def _acceptance_failures(result: dict[str, object], *, release_soak: bool) -> list[str]:
    """Return privacy-safe reason codes for every unmet soak requirement."""
    failures: list[str] = []

    if result.get("failure") is not None:
        failures.append("runtime_failure")
    if result.get("packets_sent") != result.get("packets_expected"):
        failures.append("packet_count_mismatch")
    if result.get("ffmpeg_exit_code") != 0:
        failures.append("ffmpeg_exit_nonzero")
    if result.get("sidecar_exit_code") != 0:
        failures.append("sidecar_exit_nonzero")
    if result.get("shutdown_received") is not True:
        failures.append("sidecar_shutdown_missing")
    if result.get("sidecar_stderr_line_count") != 0:
        failures.append("sidecar_stderr_not_empty")
    if result.get("ffmpeg_stderr_line_count") != 0:
        failures.append("ffmpeg_stderr_not_empty")

    events = result.get("events")
    if not isinstance(events, dict):
        failures.append("event_summary_missing")
    else:
        if events.get("stop_reason") != "stopped":
            failures.append("clean_stop_missing")
        if not isinstance(events.get("nonempty_final_segments"), int) or int(
            events["nonempty_final_segments"]
        ) <= 0:
            failures.append("nonempty_final_missing")
        if events.get("untranslated_nonempty_finals") != 0:
            failures.append("translation_payload_missing")
        if events.get("empty_final_translation_violations") != 0:
            failures.append("empty_final_translation_present")
        if events.get("translated_partial_violations") != 0:
            failures.append("partial_translation_present")
        if events.get("malformed_event_count") != 0:
            failures.append("malformed_event_present")
        if result.get("critical_codes"):
            failures.append("critical_event_present")

        latency = events.get("final_latency")
        if not isinstance(latency, dict):
            failures.append("final_latency_missing")
        else:
            p95_ms = _number(latency.get("p95_ms"))
            max_ms = _number(latency.get("max_ms"))
            if p95_ms is None or max_ms is None:
                failures.append("final_latency_missing")
            else:
                if p95_ms > MAX_FINAL_LATENCY_P95_MS:
                    failures.append("final_latency_p95_exceeded")
                if max_ms > MAX_FINAL_LATENCY_MS:
                    failures.append("final_latency_max_exceeded")

    expected_feed_seconds = _number(result.get("expected_feed_seconds"))
    actual_feed_seconds = _number(result.get("wall_clock_audio_seconds"))
    if expected_feed_seconds is None or actual_feed_seconds is None:
        failures.append("wall_clock_pacing_missing")
    elif abs(actual_feed_seconds - expected_feed_seconds) > MAX_FEED_DURATION_ERROR_SECONDS:
        failures.append("wall_clock_pacing_exceeded")

    drift_p95_ms = _number(result.get("send_drift_p95_ms"))
    drift_max_ms = _number(result.get("send_drift_max_ms"))
    if drift_p95_ms is None or drift_max_ms is None:
        failures.append("send_drift_missing")
    else:
        if drift_p95_ms > MAX_SEND_DRIFT_P95_MS:
            failures.append("send_drift_p95_exceeded")
        if drift_max_ms > MAX_SEND_DRIFT_MS:
            failures.append("send_drift_max_exceeded")

    memory = result.get("memory")
    if not isinstance(memory, dict):
        failures.append("memory_summary_missing")
    else:
        memory_delta = _number(memory.get("private_stable_window_delta_mib"))
        if memory_delta is not None and memory_delta > MAX_PRIVATE_STABLE_GROWTH_MIB:
            failures.append("private_memory_growth_exceeded")
        if release_soak:
            if memory.get("available") is not True:
                failures.append("memory_sampling_unavailable")
            if not isinstance(memory.get("sample_count"), int) or int(
                memory["sample_count"]
            ) < MIN_RELEASE_MEMORY_SAMPLES:
                failures.append("memory_sample_count_insufficient")
            if not isinstance(memory.get("first_stable_window_sample_count"), int) or int(
                memory["first_stable_window_sample_count"]
            ) < MIN_RELEASE_STABLE_WINDOW_SAMPLES:
                failures.append("memory_first_window_insufficient")
            if not isinstance(memory.get("last_stable_window_sample_count"), int) or int(
                memory["last_stable_window_sample_count"]
            ) < MIN_RELEASE_STABLE_WINDOW_SAMPLES:
                failures.append("memory_last_window_insufficient")
            if memory_delta is None:
                failures.append("memory_stable_delta_missing")

    return failures


def _terminate_process_tree(process: subprocess.Popen[Any]) -> None:
    """Best-effort cleanup of an owned subprocess and its descendants."""
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        try:
            process.wait(timeout=5)
            return
        except subprocess.TimeoutExpired:
            pass
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def run_soak(args: argparse.Namespace) -> tuple[dict[str, object], bool]:
    media = args.media.resolve()
    model_root = args.model_root.resolve()
    ffmpeg_path = Path(args.ffmpeg).resolve()
    if os.name != "nt":
        raise ValueError("The translated real-media soak is currently supported on Windows only")
    if not media.is_file():
        raise ValueError("The media path must be an existing regular file")
    if not model_root.is_absolute():
        raise ValueError("The model root must be absolute")
    if args.duration_seconds <= 0:
        raise ValueError("duration-seconds must be positive")
    if args.start_seconds < 0:
        raise ValueError("start-seconds must be non-negative")
    if args.duration_seconds < 3_600 and not args.allow_short:
        raise ValueError("A release soak must be at least 3,600 seconds; use --allow-short only for smoke tests")
    if not ffmpeg_path.is_file():
        raise ValueError("ffmpeg could not be resolved")

    model_root.mkdir(parents=True, exist_ok=True)
    backend_root = Path(__file__).resolve().parents[1]
    summary = EventSummary(args.duration_seconds)
    stderr_lines = [0]
    ffmpeg_stderr_lines = [0]
    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    environment = dict(os.environ)
    environment["PYTHONUNBUFFERED"] = "1"
    sidecar = subprocess.Popen(
        [sys.executable, "-I", "-B", "-m", "meeting_transcriber"],
        cwd=backend_root,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env=environment,
        creationflags=creation_flags,
    )
    reader = threading.Thread(target=_reader, args=(sidecar, summary), daemon=True)
    stderr_reader = threading.Thread(
        target=_drain_lines,
        args=(sidecar.stderr, stderr_lines),
        daemon=True,
    )
    reader.start()
    stderr_reader.start()
    memory = MemorySampler(sidecar.pid, summary)
    memory.start()
    ffmpeg: subprocess.Popen[bytes] | None = None
    packets_sent = 0
    send_drift_ms: list[float] = []
    audio_started_at: float | None = None
    audio_finished_at: float | None = None
    ffmpeg_exit_code: int | None = None
    tail_padding_bytes = 0
    failure: str | None = None

    try:
        start_command: dict[str, object] = {
            "type": "start",
            "model": args.model,
            "language": "en",
            "device": "cpu",
            "compute": "int8",
            "download_root": str(model_root / "asr"),
            "diarization": "online" if args.diarization else "off",
            "diarization_model": (
                str(model_root / "wespeaker_en_voxceleb_CAM++.onnx")
                if args.diarization
                else None
            ),
            "translation": "en_to_pt_br",
            "translation_model": str(model_root / "translation"),
        }
        _write_command(sidecar, start_command)
        ready_deadline = time.monotonic() + args.ready_timeout_seconds
        while not summary.ready.wait(0.25):
            if summary.unavailable.is_set():
                raise RuntimeError("The sidecar reported that its engine is unavailable")
            if sidecar.poll() is not None:
                raise RuntimeError("The sidecar exited before becoming ready")
            if time.monotonic() >= ready_deadline:
                raise TimeoutError("The sidecar did not become ready before the timeout")

        ffmpeg_command = _build_ffmpeg_command(
            ffmpeg_path,
            media,
            args.duration_seconds,
            args.start_seconds,
        )
        ffmpeg = subprocess.Popen(
            ffmpeg_command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=creation_flags,
        )
        assert ffmpeg.stdout is not None
        ffmpeg_stderr_reader = threading.Thread(
            target=_drain_lines,
            args=(ffmpeg.stderr, ffmpeg_stderr_lines),
            daemon=True,
        )
        ffmpeg_stderr_reader.start()

        expected_packets = args.duration_seconds * 1_000 // PACKET_MS
        audio_started_at = time.monotonic()
        summary.set_audio_origin(audio_started_at)
        for packet_index in range(expected_packets):
            packet = _read_exact(ffmpeg.stdout, PACKET_BYTES)
            if len(packet) != PACKET_BYTES:
                # Codec priming can leave only the last few milliseconds short.
                # Pad only a present, sample-aligned final tail, capped at 20 ms;
                # an empty or materially truncated source still fails closed.
                missing = PACKET_BYTES - len(packet)
                if (
                    packet_index == expected_packets - 1
                    and packet
                    and len(packet) % 2 == 0
                    and missing <= SAMPLE_RATE_HZ * 2 * 20 // 1_000
                ):
                    packet += bytes(missing)
                    tail_padding_bytes = missing
                else:
                    raise RuntimeError(
                        f"ffmpeg ended after {packets_sent} complete packets; expected {expected_packets}"
                    )
            deadline = audio_started_at + packet_index * PACKET_MS / 1_000
            _wait_until(deadline)
            sent_at = time.monotonic()
            send_drift_ms.append((sent_at - deadline) * 1_000)
            start_ms = packet_index * PACKET_MS
            _write_command(
                sidecar,
                {
                    "type": "audio",
                    "track": "system",
                    "start_ms": start_ms,
                    "end_ms": start_ms + PACKET_MS,
                    "pcm_s16le_base64": base64.b64encode(packet).decode("ascii"),
                },
            )
            packets_sent += 1
            if packets_sent % (60_000 // PACKET_MS) == 0:
                progress = summary.snapshot()
                progress.update(
                    {
                        "progress": "real_media_soak",
                        "audio_minutes_sent": packets_sent * PACKET_MS // 60_000,
                        "target_minutes": round(args.duration_seconds / 60, 2),
                    }
                )
                print(json.dumps(progress, sort_keys=True), flush=True)

        audio_finished_at = time.monotonic()
        ffmpeg.stdout.close()
        ffmpeg_exit_code = ffmpeg.wait(timeout=30)
        ffmpeg_stderr_reader.join(timeout=2)
        if ffmpeg_exit_code != 0:
            raise RuntimeError("ffmpeg failed while decoding the soak source")

        _write_command(sidecar, {"type": "stop"})
        if not summary.stopped.wait(args.stop_timeout_seconds):
            raise TimeoutError("The sidecar did not finish draining before the stop timeout")
        _write_command(sidecar, {"type": "shutdown"})
        if not summary.shutdown.wait(10):
            raise TimeoutError("The sidecar did not confirm shutdown before the timeout")
    except Exception as exc:
        failure = _safe_failure_code(exc)
    finally:
        if ffmpeg is not None and ffmpeg.poll() is None:
            _terminate_process_tree(ffmpeg)
        if sidecar.poll() is None:
            try:
                _write_command(sidecar, {"type": "shutdown"})
            except (BrokenPipeError, OSError, RuntimeError):
                pass
        if sidecar.stdin is not None:
            sidecar.stdin.close()
        try:
            sidecar.wait(timeout=15)
        except subprocess.TimeoutExpired:
            _terminate_process_tree(sidecar)
        memory.stop()
        reader.join(timeout=2)
        stderr_reader.join(timeout=2)

    event_result = summary.result()
    expected_packets = args.duration_seconds * 1_000 // PACKET_MS
    critical_codes = sorted(_critical_codes(event_result))
    memory_result = memory.result(args.duration_seconds)
    expected_feed_seconds = max(0.0, (expected_packets - 1) * PACKET_MS / 1_000)
    result: dict[str, object] = {
        "test": "wall_clock_real_media_jsonl_translation_soak",
        "failure": failure,
        "acceptance_scope": "release" if not args.allow_short else "smoke",
        "model": args.model,
        "language": "en",
        "translation": "en_to_pt_br",
        "translation_semantics_validated": False,
        "diarization": "online" if args.diarization else "off",
        "target_audio_seconds": args.duration_seconds,
        "source_start_seconds": args.start_seconds,
        "packets_expected": expected_packets,
        "packets_sent": packets_sent,
        "accepted_audio_ms": packets_sent * PACKET_MS,
        "expected_feed_seconds": expected_feed_seconds,
        "wall_clock_audio_seconds": (
            round(audio_finished_at - audio_started_at, 3)
            if audio_finished_at is not None and audio_started_at is not None
            else None
        ),
        "send_drift_p95_ms": (
            round(_percentile(send_drift_ms, 0.95) or 0.0, 1) if send_drift_ms else None
        ),
        "send_drift_max_ms": round(max(send_drift_ms), 1) if send_drift_ms else None,
        "ffmpeg_exit_code": ffmpeg_exit_code,
        "codec_tail_padding_bytes": tail_padding_bytes,
        "sidecar_exit_code": sidecar.returncode,
        "shutdown_received": summary.shutdown.is_set(),
        "sidecar_stderr_line_count": stderr_lines[0],
        "ffmpeg_stderr_line_count": ffmpeg_stderr_lines[0],
        "critical_codes": critical_codes,
        "memory": memory_result,
        "events": event_result,
    }
    acceptance_failures = _acceptance_failures(result, release_soak=not args.allow_short)
    passed = not acceptance_failures
    result["acceptance_failures"] = acceptance_failures
    result["passed"] = passed
    return result, passed


def _parser() -> argparse.ArgumentParser:
    default_ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("media", type=Path)
    parser.add_argument("--model-root", required=True, type=Path)
    parser.add_argument("--duration-seconds", type=int, default=3_600)
    parser.add_argument("--start-seconds", type=int, default=0)
    parser.add_argument("--model", default="small.en")
    parser.add_argument("--ffmpeg", default=default_ffmpeg)
    parser.add_argument("--diarization", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--ready-timeout-seconds", type=float, default=600)
    parser.add_argument("--stop-timeout-seconds", type=float, default=600)
    parser.add_argument(
        "--allow-short",
        action="store_true",
        help="Allow a sub-hour smoke run; never use this as release soak evidence.",
    )
    return parser


def main() -> int:
    try:
        result, passed = run_soak(_parser().parse_args())
    except Exception as exc:
        result = {
            "test": "wall_clock_real_media_jsonl_translation_soak",
            "passed": False,
            "failure": _safe_failure_code(exc),
        }
        passed = False
    print(json.dumps(result, sort_keys=True), flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
