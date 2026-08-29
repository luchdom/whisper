"""Injectable transcription engines, including a lazy faster-whisper adapter."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
import math
import os
from pathlib import Path
from typing import Protocol

from .audio import SAMPLE_RATE_HZ
from .model_manifest import ModelManifest, get_model_manifest
from .provisioning import provision_directory, remove_staging_entry
from .segmentation import InferenceJob


@dataclass(frozen=True, slots=True)
class EngineSettings:
    model: str = "small"
    language: str | None = None
    device: str = "auto"
    compute: str = "default"
    download_root: str | None = None
    diarization: str = "off"
    diarization_model: str | None = None
    translation: str = "off"
    translation_model: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.diarization, str) or self.diarization not in {"off", "online"}:
            raise ValueError("diarization must be 'off' or 'online'")
        if self.diarization_model is not None:
            if (
                not isinstance(self.diarization_model, str)
                or not self.diarization_model.strip()
                or "\x00" in self.diarization_model
            ):
                raise ValueError("diarization_model must be a valid local path or null")
        if not isinstance(self.translation, str) or self.translation not in {"off", "en_to_pt_br"}:
            raise ValueError("translation must be 'off' or 'en_to_pt_br'")
        if self.translation_model is not None:
            if (
                not isinstance(self.translation_model, str)
                or not self.translation_model.strip()
                or "\x00" in self.translation_model
            ):
                raise ValueError("translation_model must be a valid local path or null")

    def updated(self, changes: dict[str, object]) -> "EngineSettings":
        unknown = set(changes) - {
            "model",
            "language",
            "device",
            "compute",
            "download_root",
            "diarization",
            "diarization_model",
            "translation",
            "translation_model",
        }
        if unknown:
            raise ValueError(f"Unknown engine setting(s): {', '.join(sorted(unknown))}")
        return replace(self, **changes)


@dataclass(frozen=True, slots=True)
class TranscriptionResult:
    text: str
    language: str | None
    language_probability: float | None = None


MODEL_LOAD_PHASES = frozenset(
    {
        "checking_cache",
        "downloading",
        "verifying",
        "initializing",
        "preparing_speakers",
        "checking_translation_cache",
        "downloading_translation",
        "verifying_translation",
        "converting_translation",
        "initializing_translation",
    }
)


@dataclass(frozen=True, slots=True)
class ModelLoadProgress:
    phase: str

    def __post_init__(self) -> None:
        if self.phase not in MODEL_LOAD_PHASES:
            raise ValueError(f"Unsupported model load phase: {self.phase}")


ProgressSink = Callable[[ModelLoadProgress], None]


class TranscriptionEngine(Protocol):
    def configure(self, settings: EngineSettings) -> None: ...

    def prepare(self) -> None: ...

    def transcribe(self, job: InferenceJob, language: str | None) -> TranscriptionResult: ...

    def close(self) -> None: ...


class FasterWhisperEngine:
    """Lazy, entirely local inference once faster-whisper model files exist."""

    def __init__(
        self,
        progress_sink: ProgressSink | None = None,
        *,
        manifest_provider: Callable[[], ModelManifest] = get_model_manifest,
    ) -> None:
        self.settings = EngineSettings()
        self._loaded_identity: tuple[str, str, str, str | None] | None = None
        self._model: object | None = None
        self._progress_sink = progress_sink
        self._manifest_provider = manifest_provider

    def set_progress_sink(self, progress_sink: ProgressSink | None) -> None:
        self._progress_sink = progress_sink

    def configure(self, settings: EngineSettings) -> None:
        self.settings = settings
        if self._loaded_identity is not None and self._loaded_identity != _load_identity(settings):
            self._model = None
            self._loaded_identity = None

    def prepare(self) -> None:
        identity = _load_identity(self.settings)
        manifest = self._manifest_provider()
        spec = manifest.asr_model(self.settings.model)
        model_root = _model_root(self.settings)
        target = model_root / f"{spec.id}-{spec.revision}"
        # Imports stay here so protocol parsing and tests do not import heavy ASR
        # libraries, initialize devices, download models, or access the network.
        from faster_whisper import WhisperModel
        from faster_whisper.utils import download_model

        self._emit_progress("checking_cache")

        def fetch_to_staging(staging: Path) -> None:
            self._emit_progress("downloading")
            resolved = Path(
                download_model(
                    spec.repository,
                    output_dir=str(staging),
                    revision=spec.revision,
                )
            )
            if resolved.resolve() != staging.resolve():
                raise RuntimeError("The transcription model download used an unexpected directory")
            # huggingface_hub creates only transfer metadata here. It is not a
            # runtime artifact and must not survive exact manifest validation.
            remove_staging_entry(staging, ".cache")

        resolved_model = provision_directory(
            target=target,
            files=spec.files,
            fetch_to_staging=fetch_to_staging,
            progress=self._map_provisioning_progress,
        )

        if self._model is not None and self._loaded_identity == identity:
            return
        self._emit_progress("initializing")

        kwargs: dict[str, object] = {
            "device": self.settings.device,
            "compute_type": self.settings.compute,
            "local_files_only": True,
        }
        self._model = WhisperModel(str(resolved_model), **kwargs)
        self._loaded_identity = identity

    def transcribe(self, job: InferenceJob, language: str | None) -> TranscriptionResult:
        if self._model is None or self._loaded_identity != _load_identity(self.settings):
            self.prepare()
        import numpy as np

        assert self._model is not None
        audio = np.frombuffer(job.pcm_s16le, dtype="<i2").astype(np.float32) / 32768.0
        selected_language = None if language in {None, "auto"} else language
        segments, info = self._model.transcribe(  # type: ignore[union-attr]
            audio,
            language=selected_language,
            beam_size=5 if job.final else 1,
            condition_on_previous_text=False,
            vad_filter=False,
            without_timestamps=True,
        )
        text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
        detected_language = getattr(info, "language", None) or selected_language
        return TranscriptionResult(
            text=text,
            language=detected_language,
            language_probability=_language_probability(info),
        )

    def close(self) -> None:
        self._model = None
        self._loaded_identity = None

    def _emit_progress(self, phase: str) -> None:
        if self._progress_sink is not None:
            self._progress_sink(ModelLoadProgress(phase=phase))

    def _map_provisioning_progress(self, phase: str) -> None:
        if phase == "verifying":
            self._emit_progress("verifying")


class FakeTranscriptionEngine:
    """Deterministic engine for tests and explicit local UI smoke runs."""

    def __init__(self) -> None:
        self.settings = EngineSettings()
        self.prepared = False
        self.calls: list[InferenceJob] = []

    def configure(self, settings: EngineSettings) -> None:
        self.settings = settings

    def prepare(self) -> None:
        self.prepared = True

    def transcribe(self, job: InferenceJob, language: str | None) -> TranscriptionResult:
        self.calls.append(job)
        label = "Meeting audio" if job.track == "system" else "You"
        duration = round(len(job.pcm_s16le) / 2 * 1000 / SAMPLE_RATE_HZ)
        state = "final" if job.final else "partial"
        return TranscriptionResult(
            text=f"{label} test speech ({duration} ms, {state})",
            language=None if language == "auto" else (language or "en"),
            language_probability=1.0,
        )

    def close(self) -> None:
        self.prepared = False


def _load_identity(settings: EngineSettings) -> tuple[str, str, str, str | None]:
    return (settings.model, settings.device, settings.compute, settings.download_root)


def default_asr_model_root() -> Path:
    if os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        root = Path(os.environ["LOCALAPPDATA"])
    elif os.environ.get("XDG_CACHE_HOME"):
        root = Path(os.environ["XDG_CACHE_HOME"])
    elif os.name == "posix" and os.uname().sysname == "Darwin":
        root = Path.home() / "Library" / "Caches"
    else:
        root = Path.home() / ".cache"
    return root / "meeting-transcriber" / "models" / "asr"


def _model_root(settings: EngineSettings) -> Path:
    if settings.download_root is None:
        return default_asr_model_root()
    root = Path(settings.download_root).expanduser()
    if not root.is_absolute():
        raise ValueError("The transcription model root must be an absolute app-owned path")
    return root


def _language_probability(info: object) -> float | None:
    value = getattr(info, "language_probability", None)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    probability = float(value)
    if not math.isfinite(probability) or not 0.0 <= probability <= 1.0:
        return None
    return probability
