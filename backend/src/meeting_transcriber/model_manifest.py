"""Strict, immutable model metadata bundled with the sidecar."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import json
from pathlib import Path, PurePosixPath
import re
from typing import Any
from urllib.parse import urlsplit


SCHEMA_VERSION = 1
EXPECTED_ASR_MODEL_COUNT = 14
EXPECTED_SPEAKER_MODEL_COUNT = 1
EXPECTED_TRANSLATION_MODEL_COUNT = 1
EXPECTED_TRANSLATION_SOURCE_MEMBER_COUNT = 13
MAX_MANIFEST_BYTES = 2 * 1024 * 1024

_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}\Z")
_REVISION_PATTERN = re.compile(r"[0-9a-f]{40}\Z")
_SHA256_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
_REPOSITORY_PATTERN = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9_.-]{0,95}/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\Z"
)
_VERSION_PATTERN = re.compile(r"[0-9]+(?:\.[0-9]+){1,3}\Z")
_WINDOWS_RESERVED_NAMES = {
    "con",
    "prn",
    "aux",
    "nul",
    *(f"com{index}" for index in range(1, 10)),
    *(f"lpt{index}" for index in range(1, 10)),
}
_WINDOWS_INVALID_PATH_CHARACTERS = frozenset('<>:"|?*')


class ManifestError(ValueError):
    """Raised when bundled or supplied model metadata is not schema-valid."""


@dataclass(frozen=True, slots=True)
class ManifestFile:
    path: str
    size: int
    sha256: str


@dataclass(frozen=True, slots=True)
class AsrModelSpec:
    id: str
    label: str
    tier: str
    helper: str
    language_mode: str
    repository: str
    revision: str
    license: str
    files: tuple[ManifestFile, ...]


@dataclass(frozen=True, slots=True)
class SpeakerModelSpec:
    id: str
    repository: str
    revision: str
    release_tag: str
    license: str
    url: str
    file: ManifestFile


@dataclass(frozen=True, slots=True)
class TranslationUpstreamSpec:
    repository: str
    revision: str
    license: str


@dataclass(frozen=True, slots=True)
class TranslationSourceMember(ManifestFile):
    extract: bool


@dataclass(frozen=True, slots=True)
class TranslationSourceSpec:
    url: str
    size: int
    sha256: str
    members: tuple[TranslationSourceMember, ...]


@dataclass(frozen=True, slots=True)
class TranslationConversionSpec:
    tool: str
    version: str
    quantization: str
    target_token: str
    files: tuple[ManifestFile, ...]


@dataclass(frozen=True, slots=True)
class TranslationModelSpec:
    id: str
    mode: str
    label: str
    platforms: tuple[str, ...]
    upstream: TranslationUpstreamSpec
    source: TranslationSourceSpec
    conversion: TranslationConversionSpec


@dataclass(frozen=True, slots=True)
class ModelManifest:
    schema_version: int
    default_asr_model: str
    asr_models: tuple[AsrModelSpec, ...]
    speaker_models: tuple[SpeakerModelSpec, ...]
    translation_models: tuple[TranslationModelSpec, ...]

    def asr_model(self, model_id: str) -> AsrModelSpec:
        for model in self.asr_models:
            if model.id == model_id:
                return model
        raise ManifestError("The selected transcription model is not in the immutable manifest")

    def speaker_model(self, model_id: str | None = None) -> SpeakerModelSpec:
        selected_id = self.speaker_models[0].id if model_id is None else model_id
        for model in self.speaker_models:
            if model.id == selected_id:
                return model
        raise ManifestError("The selected speaker model is not in the immutable manifest")

    def translation_model(self, mode_or_id: str) -> TranslationModelSpec:
        for model in self.translation_models:
            if model.id == mode_or_id or model.mode == mode_or_id:
                return model
        raise ManifestError("The selected translation model is not in the immutable manifest")


def default_manifest_path() -> Path:
    return Path(__file__).with_name("model_manifest.json")


def load_model_manifest(path: str | Path | None = None) -> ModelManifest:
    """Load and fully validate schema v1 without accepting JSON duplicate keys."""

    manifest_path = default_manifest_path() if path is None else Path(path)
    try:
        payload = manifest_path.read_bytes()
    except OSError as exc:
        raise ManifestError("The model manifest could not be read") from exc
    if not payload or len(payload) > MAX_MANIFEST_BYTES:
        raise ManifestError("The model manifest has an invalid size")
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ManifestError("The model manifest must be UTF-8") from exc
    try:
        value = json.loads(text, object_pairs_hook=_object_without_duplicate_keys)
    except ManifestError:
        raise
    except (json.JSONDecodeError, RecursionError) as exc:
        raise ManifestError("The model manifest is not valid JSON") from exc
    return _parse_manifest(value)


@lru_cache(maxsize=1)
def get_model_manifest() -> ModelManifest:
    """Return the validated bundled manifest, parsed once per process."""

    return load_model_manifest()


def _object_without_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ManifestError(f"The model manifest contains duplicate key {key!r}")
        result[key] = value
    return result


def _parse_manifest(value: Any) -> ModelManifest:
    root = _record(
        value,
        {
            "schema_version",
            "default_asr_model",
            "asr_models",
            "speaker_models",
            "translation_models",
        },
        "manifest",
    )
    schema_version = _integer(root["schema_version"], "manifest.schema_version", minimum=1)
    if schema_version != SCHEMA_VERSION:
        raise ManifestError(f"Unsupported model manifest schema version: {schema_version}")

    asr_values = _array(root["asr_models"], "manifest.asr_models", EXPECTED_ASR_MODEL_COUNT)
    speaker_values = _array(
        root["speaker_models"], "manifest.speaker_models", EXPECTED_SPEAKER_MODEL_COUNT
    )
    translation_values = _array(
        root["translation_models"],
        "manifest.translation_models",
        EXPECTED_TRANSLATION_MODEL_COUNT,
    )
    asr_models = tuple(_parse_asr_model(item, index) for index, item in enumerate(asr_values))
    speaker_models = tuple(
        _parse_speaker_model(item, index) for index, item in enumerate(speaker_values)
    )
    translation_models = tuple(
        _parse_translation_model(item, index) for index, item in enumerate(translation_values)
    )

    _reject_casefold_duplicates(
        [
            *(model.id for model in asr_models),
            *(model.id for model in speaker_models),
            *(model.id for model in translation_models),
        ],
        "model IDs",
    )
    _reject_casefold_duplicates(
        [model.mode for model in translation_models], "translation modes"
    )

    default_asr_model = _identifier(root["default_asr_model"], "manifest.default_asr_model")
    if default_asr_model not in {model.id for model in asr_models}:
        raise ManifestError("The default ASR model is not present in the manifest")

    return ModelManifest(
        schema_version=schema_version,
        default_asr_model=default_asr_model,
        asr_models=asr_models,
        speaker_models=speaker_models,
        translation_models=translation_models,
    )


def _parse_asr_model(value: Any, index: int) -> AsrModelSpec:
    context = f"manifest.asr_models[{index}]"
    record = _record(
        value,
        {"id", "label", "tier", "helper", "language_mode", "repository", "revision", "license", "files"},
        context,
    )
    files = _parse_files(record["files"], f"{context}.files")
    tier = _string(record["tier"], f"{context}.tier", maximum=32)
    if tier not in {"very_light", "light", "balanced", "high", "very_high"}:
        raise ManifestError(f"{context}.tier is unsupported")
    language_mode = _string(record["language_mode"], f"{context}.language_mode", maximum=32)
    if language_mode not in {"multilingual", "english_only"}:
        raise ManifestError(f"{context}.language_mode is unsupported")
    return AsrModelSpec(
        id=_identifier(record["id"], f"{context}.id"),
        label=_string(record["label"], f"{context}.label", maximum=120),
        tier=tier,
        helper=_string(record["helper"], f"{context}.helper", maximum=240),
        language_mode=language_mode,
        repository=_repository(record["repository"], f"{context}.repository"),
        revision=_revision(record["revision"], f"{context}.revision"),
        license=_string(record["license"], f"{context}.license", maximum=80),
        files=files,
    )


def _parse_speaker_model(value: Any, index: int) -> SpeakerModelSpec:
    context = f"manifest.speaker_models[{index}]"
    record = _record(
        value,
        {"id", "repository", "revision", "release_tag", "license", "url", "file"},
        context,
    )
    return SpeakerModelSpec(
        id=_identifier(record["id"], f"{context}.id"),
        repository=_repository(record["repository"], f"{context}.repository"),
        revision=_revision(record["revision"], f"{context}.revision"),
        release_tag=_string(record["release_tag"], f"{context}.release_tag", maximum=120),
        license=_string(record["license"], f"{context}.license", maximum=80),
        url=_https_url(record["url"], f"{context}.url"),
        file=_parse_file(record["file"], f"{context}.file"),
    )


def _parse_translation_model(value: Any, index: int) -> TranslationModelSpec:
    context = f"manifest.translation_models[{index}]"
    record = _record(
        value,
        {"id", "mode", "label", "platforms", "upstream", "source", "conversion"},
        context,
    )
    platforms_value = _array(record["platforms"], f"{context}.platforms")
    platforms = tuple(
        _string(item, f"{context}.platforms[{platform_index}]", maximum=32)
        for platform_index, item in enumerate(platforms_value)
    )
    _reject_casefold_duplicates(platforms, f"{context}.platforms")
    if platforms != ("win32-x64",):
        raise ManifestError(f"{context}.platforms must contain only win32-x64")

    upstream_value = _record(
        record["upstream"], {"repository", "revision", "license"}, f"{context}.upstream"
    )
    upstream = TranslationUpstreamSpec(
        repository=_repository(upstream_value["repository"], f"{context}.upstream.repository"),
        revision=_revision(upstream_value["revision"], f"{context}.upstream.revision"),
        license=_string(upstream_value["license"], f"{context}.upstream.license", maximum=80),
    )

    source_value = _record(
        record["source"], {"url", "size", "sha256", "members"}, f"{context}.source"
    )
    member_values = _array(
        source_value["members"],
        f"{context}.source.members",
        EXPECTED_TRANSLATION_SOURCE_MEMBER_COUNT,
    )
    members = tuple(
        _parse_translation_member(item, f"{context}.source.members[{member_index}]")
        for member_index, item in enumerate(member_values)
    )
    _reject_casefold_duplicates(
        [member.path for member in members], f"{context}.source.members paths"
    )
    if not any(member.extract for member in members):
        raise ManifestError(f"{context}.source.members must extract at least one file")
    source_url = _https_url(source_value["url"], f"{context}.source.url")
    parsed_source_url = urlsplit(source_url)
    try:
        source_port = parsed_source_url.port
    except ValueError as exc:
        raise ManifestError(f"{context}.source.url has an invalid port") from exc
    if (
        parsed_source_url.hostname != "object.pouta.csc.fi"
        or source_port is not None
        or parsed_source_url.query
        or not parsed_source_url.path.startswith("/")
    ):
        raise ManifestError(f"{context}.source.url must use the fixed translation archive host")
    source = TranslationSourceSpec(
        url=source_url,
        size=_integer(source_value["size"], f"{context}.source.size", minimum=1),
        sha256=_sha256(source_value["sha256"], f"{context}.source.sha256"),
        members=members,
    )

    conversion_value = _record(
        record["conversion"],
        {"tool", "version", "quantization", "target_token", "files"},
        f"{context}.conversion",
    )
    tool = _string(conversion_value["tool"], f"{context}.conversion.tool", maximum=32)
    if tool != "ctranslate2":
        raise ManifestError(f"{context}.conversion.tool is unsupported")
    version = _string(conversion_value["version"], f"{context}.conversion.version", maximum=32)
    if _VERSION_PATTERN.fullmatch(version) is None or version != "4.8.1":
        raise ManifestError(f"{context}.conversion.version must be exactly 4.8.1")
    quantization = _string(
        conversion_value["quantization"], f"{context}.conversion.quantization", maximum=32
    )
    if quantization != "int8":
        raise ManifestError(f"{context}.conversion.quantization must be int8")
    target_token = _string(
        conversion_value["target_token"], f"{context}.conversion.target_token", maximum=32
    )
    if target_token != ">>pob<<":
        raise ManifestError(f"{context}.conversion.target_token must be exactly >>pob<<")
    conversion = TranslationConversionSpec(
        tool=tool,
        version=version,
        quantization=quantization,
        target_token=target_token,
        files=_parse_files(conversion_value["files"], f"{context}.conversion.files"),
    )

    mode = _identifier(record["mode"], f"{context}.mode")
    if mode != "en_to_pt_br":
        raise ManifestError(f"{context}.mode is unsupported")
    return TranslationModelSpec(
        id=_identifier(record["id"], f"{context}.id"),
        mode=mode,
        label=_string(record["label"], f"{context}.label", maximum=120),
        platforms=platforms,
        upstream=upstream,
        source=source,
        conversion=conversion,
    )


def _parse_translation_member(value: Any, context: str) -> TranslationSourceMember:
    record = _record(value, {"path", "size", "sha256", "extract"}, context)
    extract = record["extract"]
    if not isinstance(extract, bool):
        raise ManifestError(f"{context}.extract must be a boolean")
    return TranslationSourceMember(
        path=_safe_path(record["path"], f"{context}.path"),
        size=_integer(record["size"], f"{context}.size", minimum=0),
        sha256=_sha256(record["sha256"], f"{context}.sha256"),
        extract=extract,
    )


def _parse_files(value: Any, context: str) -> tuple[ManifestFile, ...]:
    values = _array(value, context)
    files = tuple(_parse_file(item, f"{context}[{index}]") for index, item in enumerate(values))
    _reject_casefold_duplicates([item.path for item in files], f"{context} paths")
    return files


def _parse_file(value: Any, context: str) -> ManifestFile:
    record = _record(value, {"path", "size", "sha256"}, context)
    return ManifestFile(
        path=_safe_path(record["path"], f"{context}.path"),
        size=_integer(record["size"], f"{context}.size", minimum=0),
        sha256=_sha256(record["sha256"], f"{context}.sha256"),
    )


def _record(value: Any, keys: set[str], context: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ManifestError(f"{context} must be an object")
    actual = set(value)
    unknown = actual - keys
    if unknown:
        raise ManifestError(f"{context} contains unknown field(s): {', '.join(sorted(unknown))}")
    missing = keys - actual
    if missing:
        raise ManifestError(f"{context} is missing field(s): {', '.join(sorted(missing))}")
    return value


def _array(value: Any, context: str, exact_count: int | None = None) -> list[Any]:
    if not isinstance(value, list):
        raise ManifestError(f"{context} must be an array")
    if exact_count is not None and len(value) != exact_count:
        raise ManifestError(f"{context} must contain exactly {exact_count} entries")
    if not value:
        raise ManifestError(f"{context} must not be empty")
    return value


def _string(value: Any, context: str, *, maximum: int) -> str:
    if not isinstance(value, str) or not value or value != value.strip() or "\x00" in value:
        raise ManifestError(f"{context} must be a non-empty canonical string")
    if len(value) > maximum:
        raise ManifestError(f"{context} is too long")
    return value


def _integer(value: Any, context: str, *, minimum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ManifestError(f"{context} must be an integer greater than or equal to {minimum}")
    return value


def _identifier(value: Any, context: str) -> str:
    identifier = _string(value, context, maximum=64)
    if _ID_PATTERN.fullmatch(identifier) is None:
        raise ManifestError(f"{context} is not a canonical identifier")
    return identifier


def _repository(value: Any, context: str) -> str:
    repository = _string(value, context, maximum=192)
    if _REPOSITORY_PATTERN.fullmatch(repository) is None:
        raise ManifestError(f"{context} is not an owner/repository identifier")
    return repository


def _revision(value: Any, context: str) -> str:
    revision = _string(value, context, maximum=40)
    if _REVISION_PATTERN.fullmatch(revision) is None:
        raise ManifestError(f"{context} must be a full 40-character lowercase commit SHA")
    return revision


def _sha256(value: Any, context: str) -> str:
    digest = _string(value, context, maximum=64)
    if _SHA256_PATTERN.fullmatch(digest) is None:
        raise ManifestError(f"{context} must be a 64-character lowercase SHA-256 digest")
    return digest


def _safe_path(value: Any, context: str) -> str:
    path = _string(value, context, maximum=240)
    if "\\" in path or any(ord(character) < 32 for character in path):
        raise ManifestError(f"{context} must be a safe relative POSIX path")
    pure = PurePosixPath(path)
    if pure.is_absolute() or pure.as_posix() != path or any(part in {"", ".", ".."} for part in pure.parts):
        raise ManifestError(f"{context} must be a safe relative POSIX path")
    for part in pure.parts:
        if (
            any(character in _WINDOWS_INVALID_PATH_CHARACTERS for character in part)
            or part.endswith((" ", "."))
            or part.split(".", 1)[0].casefold() in _WINDOWS_RESERVED_NAMES
        ):
            raise ManifestError(f"{context} is not safe on Windows")
    return path


def _https_url(value: Any, context: str) -> str:
    url = _string(value, context, maximum=2_048)
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise ManifestError(f"{context} must be an HTTPS URL without credentials or fragments")
    return url


def _reject_casefold_duplicates(values: list[str] | tuple[str, ...], context: str) -> None:
    seen: set[str] = set()
    for value in values:
        folded = value.casefold()
        if folded in seen:
            raise ManifestError(f"{context} contain a duplicate value: {value}")
        seen.add(folded)
