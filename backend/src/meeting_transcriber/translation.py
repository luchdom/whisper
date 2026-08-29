"""Verified, opt-in English to Brazilian Portuguese local translation."""

from __future__ import annotations

from collections.abc import Callable, Sequence
import hashlib
import math
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import sys
from typing import ContextManager, Protocol
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import zipfile

from .model_manifest import TranslationModelSpec, get_model_manifest


TRANSLATION_MODE = "en_to_pt_br"
TRANSLATED_LANGUAGE = "pt-BR"
MAX_TRANSLATION_INPUT_CHARS = 4_000
MAX_SOURCE_PIECES = 512
MAX_OUTPUT_PIECES = 512
ARCHIVE_HOST = "object.pouta.csc.fi"
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
ALLOWED_ZIP_COMPRESSION = frozenset({zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED})


class TranslationError(RuntimeError):
    """A local translation operation could not be completed safely."""


class TranslationUnavailableError(TranslationError):
    """The verified translation runtime is unavailable on this platform."""


class TranslationProgressSink(Protocol):
    def __call__(self, phase: str) -> None: ...


class TranslatorProtocol(Protocol):
    def set_progress_sink(self, progress_sink: TranslationProgressSink | None) -> None: ...

    def prepare(self) -> None: ...

    def translate(self, text: str) -> str: ...

    def close(self) -> None: ...


class NoOpTranslator:
    def set_progress_sink(self, progress_sink: TranslationProgressSink | None) -> None:
        del progress_sink

    def prepare(self) -> None:
        return

    def translate(self, text: str) -> str:
        del text
        raise TranslationUnavailableError("Translation is disabled")

    def close(self) -> None:
        return


class LocalCTranslate2Translator:
    """Windows-x64-only translator over a verified, locally converted OPUS model."""

    def __init__(
        self,
        model_root: str | Path | None,
        *,
        manifest_provider: Callable[[], object] = get_model_manifest,
        directory_provisioner: Callable[..., Path] | None = None,
        opener: Callable[..., ContextManager[object]] = urlopen,
        converter_factory: Callable[[str], object] | None = None,
        runtime_factory: Callable[[str], object] | None = None,
        sentencepiece_factory: Callable[[], object] | None = None,
        platform_key: str | None = None,
    ) -> None:
        self.model_root = Path(model_root).expanduser() if model_root is not None else None
        self._manifest_provider = manifest_provider
        self._directory_provisioner = directory_provisioner or _default_directory_provisioner
        self._opener = opener
        self._converter_factory = converter_factory or _default_converter_factory
        self._runtime_factory = runtime_factory or _default_runtime_factory
        self._sentencepiece_factory = sentencepiece_factory or _default_sentencepiece_factory
        self._platform_key = platform_key or current_platform_key()
        self._progress_sink: TranslationProgressSink | None = None
        self._runtime: object | None = None
        self._source_sp: object | None = None
        self._target_sp: object | None = None
        self._spec: TranslationModelSpec | None = None
        self._prepared_path: Path | None = None

    def set_progress_sink(self, progress_sink: TranslationProgressSink | None) -> None:
        self._progress_sink = progress_sink

    def prepare(self) -> None:
        if self._runtime is not None:
            return
        if self.model_root is None or not self.model_root.is_absolute():
            raise TranslationUnavailableError("A main-owned absolute translation model root is required")

        manifest = self._manifest_provider()
        spec = manifest.translation_model(TRANSLATION_MODE)  # type: ignore[attr-defined]
        if self._platform_key not in spec.platforms:
            raise TranslationUnavailableError("Translation is unavailable on this platform")

        target = self.model_root / spec.id
        self._emit("checking_translation_cache")

        def fetch_to_staging(staging: Path) -> None:
            self._build_verified_model(staging, spec)

        required_bytes = (
            spec.source.size
            + sum(member.size for member in spec.source.members if member.extract)
            + sum(file.size for file in spec.conversion.files)
        )
        prepared = self._directory_provisioner(
            target=target,
            files=spec.conversion.files,
            fetch_to_staging=fetch_to_staging,
            required_bytes=required_bytes,
            progress=self._map_provisioning_progress,
        )
        self._emit("initializing_translation")
        runtime = self._runtime_factory(str(prepared))
        source_sp = self._sentencepiece_factory()
        target_sp = self._sentencepiece_factory()
        if not source_sp.load(str(prepared / "source.spm")):  # type: ignore[attr-defined]
            raise TranslationError("The source tokenizer could not be opened")
        if not target_sp.load(str(prepared / "target.spm")):  # type: ignore[attr-defined]
            raise TranslationError("The target tokenizer could not be opened")
        self._runtime = runtime
        self._source_sp = source_sp
        self._target_sp = target_sp
        self._spec = spec
        self._prepared_path = prepared

    def translate(self, text: str) -> str:
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TRANSLATION_INPUT_CHARS:
            raise TranslationError("Translation input is invalid or too long")
        self.prepare()
        assert self._runtime is not None
        assert self._source_sp is not None
        assert self._target_sp is not None
        assert self._spec is not None

        encoded = self._source_sp.encode(text, out_type=str)  # type: ignore[attr-defined]
        if not isinstance(encoded, list) or any(not isinstance(piece, str) for piece in encoded):
            raise TranslationError("The source tokenizer returned invalid pieces")
        source_tokens = [self._spec.conversion.target_token, *encoded]
        if len(source_tokens) > MAX_SOURCE_PIECES:
            raise TranslationError("Translation input exceeds the source-piece limit")

        results = self._runtime.translate_batch(  # type: ignore[attr-defined]
            [source_tokens],
            beam_size=4,
            max_batch_size=1,
            max_decoding_length=MAX_OUTPUT_PIECES,
        )
        if not isinstance(results, Sequence) or len(results) != 1:
            raise TranslationError("The translation runtime returned an invalid batch")
        hypotheses = getattr(results[0], "hypotheses", None)
        if not isinstance(hypotheses, Sequence) or len(hypotheses) != 1:
            raise TranslationError("The translation runtime returned an invalid hypothesis")
        pieces = hypotheses[0]
        if (
            not isinstance(pieces, Sequence)
            or isinstance(pieces, (str, bytes))
            or len(pieces) > MAX_OUTPUT_PIECES
            or any(not isinstance(piece, str) for piece in pieces)
        ):
            raise TranslationError("The translation output exceeds the piece limit")
        translated = self._target_sp.decode(list(pieces))  # type: ignore[attr-defined]
        if not isinstance(translated, str) or not translated.strip():
            raise TranslationError("The translation runtime returned empty text")
        return translated.strip()

    def close(self) -> None:
        self._runtime = None
        self._source_sp = None
        self._target_sp = None
        self._spec = None
        self._prepared_path = None

    def _build_verified_model(self, staging: Path, spec: TranslationModelSpec) -> None:
        archive_path = staging / ".source.zip"
        extracted = staging / ".source"
        converted = staging / ".converted"
        extracted.mkdir()
        try:
            self._emit("downloading_translation")
            _download_archive(spec, archive_path, opener=self._opener)
            self._emit("verifying_translation")
            _inspect_and_extract_archive(archive_path, extracted, spec)
            self._emit("converting_translation")
            converter = self._converter_factory(str(extracted))
            converter.convert(  # type: ignore[attr-defined]
                str(converted),
                quantization=spec.conversion.quantization,
                force=False,
            )
            for filename in ("source.spm", "target.spm", "LICENSE", "README.md"):
                _copy_regular_file(extracted / filename, converted / filename)
            _verify_converted_directory(converted, spec)
            for file in spec.conversion.files:
                os.replace(converted / file.path, staging / file.path)
            _fsync_directory(staging)
        finally:
            archive_path.unlink(missing_ok=True)
            shutil.rmtree(extracted, ignore_errors=True)
            shutil.rmtree(converted, ignore_errors=True)

    def _map_provisioning_progress(self, phase: str) -> None:
        if phase == "verifying":
            self._emit("verifying_translation")

    def _emit(self, phase: str) -> None:
        if self._progress_sink is not None:
            self._progress_sink(phase)


def current_platform_key() -> str:
    machine = platform.machine().casefold()
    if sys.platform == "win32" and machine in {"amd64", "x86_64"}:
        return "win32-x64"
    if sys.platform == "darwin" and machine in {"arm64", "aarch64"}:
        return "darwin-arm64"
    return f"{sys.platform}-{machine or 'unknown'}"


def _download_archive(
    spec: TranslationModelSpec,
    destination: Path,
    *,
    opener: Callable[..., ContextManager[object]],
) -> None:
    source = spec.source
    try:
        parsed = urlparse(source.url)
        source_port = parsed.port
    except (TypeError, ValueError) as exc:
        raise TranslationError("The translation archive source is invalid") from exc
    if (
        parsed.scheme != "https"
        or parsed.hostname != ARCHIVE_HOST
        or source_port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not parsed.path.startswith("/")
    ):
        raise TranslationError("The translation archive source is not allowlisted")
    request = Request(
        source.url,
        headers={"Accept": "application/zip", "User-Agent": "meeting-transcriber/0.1"},
    )
    digest = hashlib.sha256()
    total = 0
    with destination.open("xb") as output, opener(request, timeout=30) as response:
        effective_url_getter = getattr(response, "geturl", None)
        effective_url = effective_url_getter() if callable(effective_url_getter) else source.url
        try:
            effective = urlparse(effective_url)
            effective_port = effective.port
        except (TypeError, ValueError) as exc:
            raise TranslationError("The translation archive redirect is invalid") from exc
        if (
            effective.scheme != "https"
            or effective.hostname != ARCHIVE_HOST
            or effective_port is not None
            or effective.username is not None
            or effective.password is not None
            or effective.query
            or effective.fragment
        ):
            raise TranslationError("The translation archive redirected outside the allowlisted host")
        while True:
            chunk = response.read(DOWNLOAD_CHUNK_BYTES)  # type: ignore[attr-defined]
            if not chunk:
                break
            if not isinstance(chunk, bytes):
                raise TranslationError("The translation archive stream is invalid")
            total += len(chunk)
            if total > source.size:
                raise TranslationError("The translation archive exceeded its strict size cap")
            digest.update(chunk)
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    if total != source.size or digest.hexdigest() != source.sha256:
        raise TranslationError("The translation archive failed integrity verification")


def _inspect_and_extract_archive(
    archive_path: Path,
    destination: Path,
    spec: TranslationModelSpec,
) -> None:
    expected = {member.path: member for member in spec.source.members}
    expected_casefold = {path.casefold() for path in expected}
    seen: set[str] = set()
    seen_casefold: set[str] = set()
    total_declared = 0
    with zipfile.ZipFile(archive_path, "r", allowZip64=True) as archive:
        entries = archive.infolist()
        if len(entries) != len(expected):
            raise TranslationError("The translation archive has an unexpected member count")
        for entry in entries:
            name = entry.filename
            _validate_archive_path(name)
            folded = name.casefold()
            if name in seen or folded in seen_casefold:
                raise TranslationError("The translation archive contains duplicate members")
            seen.add(name)
            seen_casefold.add(folded)
            if name not in expected or folded not in expected_casefold:
                raise TranslationError("The translation archive contains an unexpected member")
            member = expected[name]
            if entry.is_dir() or entry.flag_bits & (0x1 | 0x40):
                raise TranslationError("The translation archive contains an unsupported member")
            unix_mode = entry.external_attr >> 16
            file_type = stat.S_IFMT(unix_mode)
            if file_type not in {0, stat.S_IFREG} or stat.S_ISLNK(unix_mode):
                raise TranslationError("The translation archive contains a non-regular member")
            if entry.compress_type not in ALLOWED_ZIP_COMPRESSION:
                raise TranslationError("The translation archive uses unsupported compression")
            if entry.file_size != member.size or entry.file_size < 0 or entry.compress_size < 0:
                raise TranslationError("The translation archive member has an unexpected size")
            total_declared += entry.file_size
            if total_declared > sum(item.size for item in spec.source.members):
                raise TranslationError("The translation archive exceeds its decompression limit")

        if seen != set(expected):
            raise TranslationError("The translation archive is missing required members")

        for entry in entries:
            member = expected[entry.filename]
            target = destination / member.path if member.extract else None
            digest = hashlib.sha256()
            total = 0
            output = target.open("xb") if target is not None else None
            try:
                with archive.open(entry, "r") as source:
                    while True:
                        chunk = source.read(DOWNLOAD_CHUNK_BYTES)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > member.size:
                            raise TranslationError("A translation archive member exceeded its size cap")
                        digest.update(chunk)
                        if output is not None:
                            output.write(chunk)
                if total != member.size or digest.hexdigest() != member.sha256:
                    raise TranslationError("A translation archive member failed integrity verification")
                if output is not None:
                    output.flush()
                    os.fsync(output.fileno())
            finally:
                if output is not None:
                    output.close()
    _fsync_directory(destination)


def _validate_archive_path(name: str) -> None:
    if (
        not name
        or "\\" in name
        or "\x00" in name
        or name.startswith(("/", "//"))
        or re.match(r"^[A-Za-z]:", name)
    ):
        raise TranslationError("The translation archive contains an unsafe path")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts) or len(path.parts) != 1:
        raise TranslationError("The translation archive contains an unsafe path")


def _verify_converted_directory(directory: Path, spec: TranslationModelSpec) -> None:
    from .provisioning import verify_directory

    verify_directory(directory, spec.conversion.files)


def _copy_regular_file(source: Path, destination: Path) -> None:
    if not source.is_file() or source.is_symlink():
        raise TranslationError("A required conversion input is not a regular file")
    with source.open("rb") as input_stream, destination.open("xb") as output_stream:
        shutil.copyfileobj(input_stream, output_stream, length=DOWNLOAD_CHUNK_BYTES)
        output_stream.flush()
        os.fsync(output_stream.fileno())


def _fsync_directory(directory: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _default_directory_provisioner(**kwargs: object) -> Path:
    from .provisioning import provision_directory

    return provision_directory(**kwargs)  # type: ignore[arg-type]


def _default_converter_factory(model_dir: str) -> object:
    from ctranslate2.converters import OpusMTConverter

    return OpusMTConverter(model_dir)


def _default_runtime_factory(model_dir: str) -> object:
    import ctranslate2

    return ctranslate2.Translator(model_dir, device="cpu", compute_type="int8")


def _default_sentencepiece_factory() -> object:
    import sentencepiece

    return sentencepiece.SentencePieceProcessor()


def is_auto_detected_english(language: str | None, probability: float | None) -> bool:
    return (
        language == "en"
        and isinstance(probability, (float, int))
        and not isinstance(probability, bool)
        and math.isfinite(float(probability))
        and 0.0 <= float(probability) <= 1.0
        and float(probability) >= 0.80
    )
