"""Optional local anonymous online speaker clustering for system-track speech."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from array import array
from dataclasses import dataclass
import math
import os
from pathlib import Path
import stat
import sys
import time
from typing import ContextManager, Protocol
from urllib.request import urlopen

from .audio import SAMPLE_RATE_HZ
from .model_manifest import ManifestFile, get_model_manifest
from .provisioning import (
    CrossProcessFileLock,
    ModelIntegrityError,
    download_verified_file,
    verify_file,
)
from .segmentation import InferenceJob


_SPEAKER_MODEL_SPEC = get_model_manifest().speaker_model()
MODEL_FILENAME = _SPEAKER_MODEL_SPEC.file.path
MODEL_DOWNLOAD_URL = _SPEAKER_MODEL_SPEC.url
MODEL_SIZE_BYTES = _SPEAKER_MODEL_SPEC.file.size
MODEL_SHA256 = _SPEAKER_MODEL_SPEC.file.sha256
MAX_EMBEDDING_DIMENSIONS = 4_096
MAX_TRACKED_PARTIALS = 128
STALE_DOWNLOAD_AGE_SECONDS = 60 * 60
MAX_STALE_DOWNLOADS_TO_REMOVE = 32


class SpeakerDiarizer(Protocol):
    def prepare(self) -> None: ...

    def reset(self, session_id: str | None) -> None: ...

    def assign(self, job: InferenceJob) -> str | None: ...

    def close(self) -> None: ...


class SpeakerEmbeddingStream(Protocol):
    def accept_waveform(self, *, sample_rate: int, waveform: object) -> None: ...

    def input_finished(self) -> None: ...


class SpeakerEmbeddingExtractor(Protocol):
    def create_stream(self) -> SpeakerEmbeddingStream: ...

    def is_ready(self, stream: SpeakerEmbeddingStream) -> bool: ...

    def compute(self, stream: SpeakerEmbeddingStream) -> Sequence[float]: ...


class NoOpSpeakerDiarizer:
    """Default-off implementation with no imports, model access, or retained state."""

    def prepare(self) -> None:
        return

    def reset(self, session_id: str | None) -> None:
        del session_id

    def assign(self, job: InferenceJob) -> str | None:
        del job
        return None

    def close(self) -> None:
        return


@dataclass(slots=True)
class _Cluster:
    speaker_id: str
    centroid: tuple[float, ...]
    observations: int


class OnlineSpeakerDiarizer:
    """Incremental cosine clustering over local sherpa-onnx speaker embeddings."""

    def __init__(
        self,
        model_path: str | Path | None = None,
        *,
        extractor: SpeakerEmbeddingExtractor | None = None,
        extractor_factory: Callable[[Path], SpeakerEmbeddingExtractor] | None = None,
        model_provisioner: Callable[[str | Path | None], Path] = lambda value: ensure_model(value),
        threshold: float = 0.6,
        max_clusters: int = 16,
    ) -> None:
        if not 0.0 <= threshold <= 1.0:
            raise ValueError("threshold must be between zero and one")
        if not 1 <= max_clusters <= 16:
            raise ValueError("max_clusters must be between one and sixteen")
        self.model_path = model_path
        self.threshold = threshold
        self.max_clusters = max_clusters
        self._extractor = extractor
        self._extractor_factory = extractor_factory or _create_sherpa_extractor
        self._model_provisioner = model_provisioner
        self._clusters: list[_Cluster] = []
        self._partial_assignments: dict[str, str] = {}
        self._session_id: str | None = None

    @property
    def cluster_count(self) -> int:
        return len(self._clusters)

    @property
    def tracked_partial_count(self) -> int:
        return len(self._partial_assignments)

    @property
    def retained_pcm_bytes(self) -> int:
        return 0

    def prepare(self) -> None:
        if self._extractor is not None:
            return
        model_file = self._model_provisioner(self.model_path)
        self._extractor = self._extractor_factory(model_file)

    def reset(self, session_id: str | None) -> None:
        self._session_id = session_id
        self._clusters.clear()
        self._partial_assignments.clear()

    def assign(self, job: InferenceJob) -> str | None:
        if job.track != "system":
            return None
        self.prepare()
        assert self._extractor is not None

        stable_id = self._partial_assignments.get(job.segment_id)
        if stable_id is not None and job.partial:
            return stable_id
        if stable_id is None and job.partial and len(self._partial_assignments) >= MAX_TRACKED_PARTIALS:
            return None

        embedding = self._extract(job)
        if embedding is None:
            if job.final:
                self._partial_assignments.pop(job.segment_id, None)
            return stable_id

        if stable_id is not None:
            cluster = self._cluster_by_id(stable_id)
            cluster.centroid = _updated_centroid(cluster, embedding)
            cluster.observations += 1
            self._partial_assignments.pop(job.segment_id, None)
            return stable_id

        cluster, created = self._select_cluster(embedding)
        if job.final:
            if not created:
                cluster.centroid = _updated_centroid(cluster, embedding)
                cluster.observations += 1
        elif len(self._partial_assignments) < MAX_TRACKED_PARTIALS:
            self._partial_assignments[job.segment_id] = cluster.speaker_id
        return cluster.speaker_id

    def close(self) -> None:
        self.reset(None)
        self._extractor = None

    def _extract(self, job: InferenceJob) -> tuple[float, ...] | None:
        waveform = _pcm_to_waveform(job.pcm_s16le)
        stream = self._extractor.create_stream()  # type: ignore[union-attr]
        stream.accept_waveform(sample_rate=SAMPLE_RATE_HZ, waveform=waveform)
        stream.input_finished()
        if not self._extractor.is_ready(stream):  # type: ignore[union-attr]
            return None
        return _normalize(self._extractor.compute(stream))  # type: ignore[union-attr]

    def _select_cluster(self, embedding: tuple[float, ...]) -> tuple[_Cluster, bool]:
        if not self._clusters:
            return self._new_cluster(embedding), True
        if len(self._clusters[0].centroid) != len(embedding):
            raise ValueError("Speaker embedding dimension changed during the session")
        best = max(self._clusters, key=lambda item: _cosine(item.centroid, embedding))
        if _cosine(best.centroid, embedding) < self.threshold and len(self._clusters) < self.max_clusters:
            return self._new_cluster(embedding), True
        return best, False

    def _new_cluster(self, embedding: tuple[float, ...]) -> _Cluster:
        cluster = _Cluster(
            speaker_id=f"speaker-{len(self._clusters) + 1:02d}",
            centroid=embedding,
            observations=1,
        )
        self._clusters.append(cluster)
        return cluster

    def _cluster_by_id(self, speaker_id: str) -> _Cluster:
        return next(cluster for cluster in self._clusters if cluster.speaker_id == speaker_id)


def default_model_path() -> Path:
    if os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        root = Path(os.environ["LOCALAPPDATA"])
    elif os.environ.get("XDG_CACHE_HOME"):
        root = Path(os.environ["XDG_CACHE_HOME"])
    elif os.name == "posix" and os.uname().sysname == "Darwin":
        root = Path.home() / "Library" / "Caches"
    else:
        root = Path.home() / ".cache"
    return root / "meeting-transcriber" / "models" / MODEL_FILENAME


def ensure_model(
    supplied_path: str | Path | None,
    *,
    opener: Callable[..., ContextManager[object]] = urlopen,
) -> Path:
    target = Path(supplied_path).expanduser() if supplied_path is not None else default_model_path()
    expected = ManifestFile(path=MODEL_FILENAME, size=MODEL_SIZE_BYTES, sha256=MODEL_SHA256)
    try:
        return download_verified_file(
            target=target,
            file=expected,
            url=MODEL_DOWNLOAD_URL,
            opener=opener,
        )
    except ModelIntegrityError as exc:
        # Preserve the original public diarization provisioning contract while
        # sharing the stricter cross-process implementation underneath.
        raise ValueError(str(exc)) from exc


def _cleanup_stale_model_downloads(directory: Path, *, now: float | None = None) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    lock_path = directory / f".{MODEL_FILENAME}.lock"
    with CrossProcessFileLock(lock_path):
        cutoff = (time.time() if now is None else now) - STALE_DOWNLOAD_AGE_SECONDS
        prefix = f".{MODEL_FILENAME}."
        candidates: list[tuple[float, Path]] = []
        try:
            entries = directory.iterdir()
        except OSError:
            return

        for path in entries:
            if not path.name.startswith(prefix) or not path.name.endswith(".tmp"):
                continue
            try:
                metadata = path.lstat()
            except OSError:
                continue
            if not (stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode)):
                continue
            if metadata.st_mtime <= cutoff:
                candidates.append((metadata.st_mtime, path))

        for _modified_at, path in sorted(candidates)[:MAX_STALE_DOWNLOADS_TO_REMOVE]:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                # Cleanup is best-effort and must never prevent a verified download.
                continue


def _verify_model(path: Path) -> None:
    try:
        verify_file(
            path,
            ManifestFile(path=MODEL_FILENAME, size=MODEL_SIZE_BYTES, sha256=MODEL_SHA256),
        )
    except ModelIntegrityError as exc:
        raise ValueError(str(exc)) from exc


def _create_sherpa_extractor(model_path: Path) -> SpeakerEmbeddingExtractor:
    import sherpa_onnx

    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(model_path),
        num_threads=1,
        debug=False,
        provider="cpu",
    )
    if not config.validate():
        raise ValueError("The local speaker embedding model configuration is invalid")
    return sherpa_onnx.SpeakerEmbeddingExtractor(config)


def _pcm_to_waveform(pcm_s16le: bytes) -> object:
    try:
        import numpy as np
    except ModuleNotFoundError:
        samples = array("h")
        samples.frombytes(pcm_s16le)
        if sys.byteorder != "little":
            samples.byteswap()
        return array("f", (sample / 32768.0 for sample in samples))
    return np.frombuffer(pcm_s16le, dtype="<i2").astype(np.float32) / 32768.0


def _normalize(values: Sequence[float]) -> tuple[float, ...]:
    embedding = tuple(float(value) for value in values)
    if not embedding or len(embedding) > MAX_EMBEDDING_DIMENSIONS:
        raise ValueError("Speaker embedding has an invalid dimension")
    if any(not math.isfinite(value) for value in embedding):
        raise ValueError("Speaker embedding contains a non-finite value")
    norm = math.sqrt(math.fsum(value * value for value in embedding))
    if norm <= 1e-12:
        raise ValueError("Speaker embedding has zero magnitude")
    return tuple(value / norm for value in embedding)


def _cosine(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    if len(left) != len(right):
        raise ValueError("Speaker embedding dimensions do not match")
    return math.fsum(a * b for a, b in zip(left, right, strict=True))


def _updated_centroid(cluster: _Cluster, embedding: tuple[float, ...]) -> tuple[float, ...]:
    if len(cluster.centroid) != len(embedding):
        raise ValueError("Speaker embedding dimensions do not match")
    combined = tuple(
        centroid * cluster.observations + observed
        for centroid, observed in zip(cluster.centroid, embedding, strict=True)
    )
    return _normalize(combined)
