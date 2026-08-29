"""Cross-process, fail-closed provisioning for immutable local model files."""

from __future__ import annotations

from collections.abc import Callable, Sequence
import errno
import hashlib
import hmac
import math
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import time
from typing import BinaryIO, ContextManager
from urllib.request import Request, urlopen

from .model_manifest import ManifestFile


DOWNLOAD_CHUNK_BYTES = 1024 * 1024
DEFAULT_LOCK_TIMEOUT_SECONDS = 30.0
MAX_LOCK_TIMEOUT_SECONDS = 300.0
LOCK_POLL_INTERVAL_SECONDS = 0.1
MAX_LOCK_POLL_INTERVAL_SECONDS = 10.0
MAX_STAGING_ENTRIES_TO_REMOVE = 32
FILE_ATTRIBUTE_REPARSE_POINT = 0x0400


class ProvisioningError(RuntimeError):
    """Base class for safe local model provisioning failures."""


class ModelIntegrityError(ProvisioningError):
    """A local artifact does not exactly match its immutable manifest."""


class ProvisioningLockTimeout(ProvisioningError):
    """Another process retained a model provisioning lock for too long."""


class InsufficientDiskSpaceError(ProvisioningError):
    """The target filesystem lacks the declared bytes needed for provisioning."""


ProgressCallback = Callable[[str], None]
DirectoryFetcher = Callable[[Path], None]


class CrossProcessFileLock:
    """Small OS-backed exclusive lock that leaves a stable sibling lock file."""

    def __init__(
        self,
        path: str | Path,
        *,
        timeout_seconds: float = DEFAULT_LOCK_TIMEOUT_SECONDS,
        poll_interval_seconds: float = LOCK_POLL_INTERVAL_SECONDS,
    ) -> None:
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not math.isfinite(float(timeout_seconds))
            or timeout_seconds < 0
            or timeout_seconds > MAX_LOCK_TIMEOUT_SECONDS
        ):
            raise ValueError("Lock timeout must be a finite number between zero and 300 seconds")
        if (
            isinstance(poll_interval_seconds, bool)
            or not isinstance(poll_interval_seconds, (int, float))
            or not math.isfinite(float(poll_interval_seconds))
            or poll_interval_seconds <= 0
            or poll_interval_seconds > MAX_LOCK_POLL_INTERVAL_SECONDS
        ):
            raise ValueError("Lock poll interval must be finite and at most 10 seconds")
        self.path = _absolute_lexical_path(Path(path))
        self.timeout_seconds = float(timeout_seconds)
        self.poll_interval_seconds = float(poll_interval_seconds)
        self._stream: BinaryIO | None = None

    def __enter__(self) -> "CrossProcessFileLock":
        _prepare_plain_directory_chain(
            self.path.parent,
            "The model lock parent chain is not made of plain directories",
        )
        if _path_exists(self.path) and not is_regular_file_without_reparse(self.path):
            raise ProvisioningError("The model lock is not a regular file")

        flags = os.O_RDWR | os.O_CREAT
        flags |= getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(self.path, flags, 0o600)
        except OSError as exc:
            raise ProvisioningError("The model lock could not be opened") from exc
        stream = os.fdopen(descriptor, "r+b", buffering=0)
        try:
            metadata = os.fstat(descriptor)
            current = self.path.lstat()
            if (
                not _metadata_is_regular_without_reparse(metadata)
                or not _metadata_is_regular_without_reparse(current)
                or not _same_file_metadata(metadata, current)
            ):
                raise ProvisioningError("The model lock is not a regular file")
            if metadata.st_size == 0:
                stream.write(b"\0")
                stream.flush()
                os.fsync(descriptor)

            _require_plain_directory_chain(
                self.path.parent,
                "The model lock parent chain is not made of plain directories",
            )

            deadline = time.monotonic() + self.timeout_seconds
            while True:
                try:
                    _try_lock(descriptor)
                    break
                except OSError as exc:
                    if not _is_busy_lock_error(exc):
                        raise ProvisioningError("The model lock could not be acquired") from exc
                    if time.monotonic() >= deadline:
                        raise ProvisioningLockTimeout(
                            "Timed out waiting for another model provisioning process"
                        ) from exc
                    remaining = max(0.0, deadline - time.monotonic())
                    time.sleep(min(self.poll_interval_seconds, remaining))
        except Exception:
            stream.close()
            raise
        self._stream = stream
        return self

    def __exit__(self, *_exc: object) -> None:
        stream = self._stream
        self._stream = None
        if stream is None:
            return
        try:
            _unlock(stream.fileno())
        finally:
            stream.close()


def is_regular_file_without_reparse(path: str | Path) -> bool:
    try:
        metadata = Path(path).lstat()
    except OSError:
        return False
    return _metadata_is_regular_without_reparse(metadata)


def verify_file(path: str | Path, expected: ManifestFile) -> Path:
    """Verify type, exact byte length, and SHA-256 without following symlinks."""

    target = _absolute_lexical_path(Path(path))
    _require_plain_directory_chain(
        target.parent,
        "A required model file parent chain is not made of plain directories",
    )
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(target, flags)
    except OSError as exc:
        raise ModelIntegrityError("A required model file is missing or not a regular file") from exc
    try:
        opened = os.fstat(descriptor)
        try:
            current = target.lstat()
        except OSError as exc:
            raise ModelIntegrityError("A required model file changed during verification") from exc
        if (
            not _metadata_is_regular_without_reparse(opened)
            or not _metadata_is_regular_without_reparse(current)
            or not _same_file_metadata(opened, current)
        ):
            raise ModelIntegrityError("A required model file is not a regular file")
        if opened.st_size != expected.size:
            raise ModelIntegrityError("A model file has an unexpected size")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, DOWNLOAD_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
        if not hmac.compare_digest(digest.hexdigest(), expected.sha256):
            raise ModelIntegrityError("A model file failed SHA-256 integrity verification")
        after = os.fstat(descriptor)
        if after.st_size != opened.st_size or after.st_mtime_ns != opened.st_mtime_ns:
            raise ModelIntegrityError("A model file changed during verification")
    finally:
        os.close(descriptor)
    return target


def verify_directory(directory: str | Path, files: Sequence[ManifestFile]) -> Path:
    """Require a plain directory containing exactly the declared regular files."""

    target = _absolute_lexical_path(Path(directory))
    _require_plain_directory_chain(
        target,
        "The model directory is missing or its parent chain is not made of plain directories",
    )
    expected_paths = [_safe_relative_path(item.path) for item in files]
    if not expected_paths:
        raise ModelIntegrityError("The model file manifest is empty")
    _reject_duplicate_paths(expected_paths)
    expected_files = {path.as_posix() for path in expected_paths}
    expected_directories = {
        parent.as_posix()
        for path in expected_paths
        for parent in path.parents
        if parent != PurePosixPath(".")
    }

    actual_files: set[str] = set()
    actual_directories: set[str] = set()
    _inventory_directory(target, PurePosixPath("."), actual_files, actual_directories)
    if actual_files != expected_files or actual_directories != expected_directories:
        raise ModelIntegrityError("The model directory does not contain exactly the manifested files")
    _reject_duplicate_paths([PurePosixPath(path) for path in actual_files])
    for expected in files:
        relative = _safe_relative_path(expected.path)
        verify_file(target.joinpath(*relative.parts), expected)
    return target


def provision_directory(
    *,
    target: str | Path,
    files: Sequence[ManifestFile],
    fetch_to_staging: DirectoryFetcher,
    required_bytes: int | None = None,
    progress: ProgressCallback | None = None,
    lock_timeout_seconds: float = DEFAULT_LOCK_TIMEOUT_SECONDS,
) -> Path:
    """Verify an immutable cache or build it in a locked sibling staging directory."""

    destination = _absolute_lexical_path(Path(target))
    required = sum(item.size for item in files) if required_bytes is None else required_bytes
    if isinstance(required, bool) or not isinstance(required, int) or required < 0:
        raise ValueError("required_bytes must be a non-negative integer")
    _prepare_plain_directory_chain(
        destination.parent,
        "The model parent chain is not made of plain directories",
    )
    lock_path = destination.with_name(f".{destination.name}.lock")
    staging_prefix = f".{destination.name}.staging-"

    with CrossProcessFileLock(lock_path, timeout_seconds=lock_timeout_seconds):
        _require_plain_directory_chain(
            destination.parent,
            "The model parent chain is not made of plain directories",
        )
        _cleanup_sibling_staging(destination.parent, staging_prefix)
        if _path_exists(destination):
            _emit_progress(progress, "verifying")
            return verify_directory(destination, files)

        _require_disk_space(destination.parent, required)
        staging = Path(tempfile.mkdtemp(prefix=staging_prefix, dir=destination.parent))
        _require_plain_directory_chain(
            staging,
            "The model staging path or its parent chain is not made of plain directories",
        )
        promoted = False
        try:
            _require_plain_directory_chain(
                staging,
                "The model staging path or its parent chain is not made of plain directories",
            )
            fetch_to_staging(staging)
            _emit_progress(progress, "verifying")
            verify_directory(staging, files)
            _fsync_manifest_tree(staging, files)
            if _path_exists(destination):
                verified = verify_directory(destination, files)
                return verified
            _require_plain_directory_chain(
                destination.parent,
                "The model parent chain is not made of plain directories",
            )
            _require_plain_directory_chain(
                staging,
                "The model staging path or its parent chain is not made of plain directories",
            )
            os.replace(staging, destination)
            promoted = True
            _fsync_directory(destination.parent)
            return destination
        finally:
            if not promoted:
                _require_plain_directory_chain(
                    staging.parent,
                    "The model staging parent chain is not made of plain directories",
                )
                if _path_exists(staging):
                    _remove_scoped_path(staging)


def download_verified_file(
    *,
    target: str | Path,
    file: ManifestFile,
    url: str,
    opener: Callable[..., ContextManager[object]] = urlopen,
    lock_timeout_seconds: float = DEFAULT_LOCK_TIMEOUT_SECONDS,
) -> Path:
    """Download one exact file to a sibling staging file and atomically promote it."""

    destination = _absolute_lexical_path(Path(target))
    _prepare_plain_directory_chain(
        destination.parent,
        "The model parent chain is not made of plain directories",
    )
    lock_path = destination.with_name(f".{destination.name}.lock")
    staging_prefix = f".{destination.name}.staging-"

    with CrossProcessFileLock(lock_path, timeout_seconds=lock_timeout_seconds):
        _require_plain_directory_chain(
            destination.parent,
            "The model parent chain is not made of plain directories",
        )
        _cleanup_sibling_staging(destination.parent, staging_prefix)
        if _path_exists(destination):
            return verify_file(destination, file)
        _require_disk_space(destination.parent, file.size)
        request = Request(
            url,
            headers={"Accept": "application/octet-stream", "User-Agent": "meeting-transcriber/0.1"},
        )
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="xb",
                prefix=staging_prefix,
                suffix=".tmp",
                dir=destination.parent,
                delete=False,
            ) as temporary:
                temporary_path = Path(temporary.name)
                digest = hashlib.sha256()
                total = 0
                with opener(request, timeout=30) as response:
                    while True:
                        chunk = response.read(DOWNLOAD_CHUNK_BYTES)  # type: ignore[attr-defined]
                        if not chunk:
                            break
                        if not isinstance(chunk, bytes):
                            raise ProvisioningError("The model download stream is invalid")
                        total += len(chunk)
                        if total > file.size:
                            raise ModelIntegrityError("The model download exceeded its strict size cap")
                        digest.update(chunk)
                        temporary.write(chunk)
                if total != file.size or not hmac.compare_digest(digest.hexdigest(), file.sha256):
                    raise ModelIntegrityError("The model download failed integrity verification")
                temporary.flush()
                os.fsync(temporary.fileno())
            verify_file(temporary_path, file)
            if _path_exists(destination):
                return verify_file(destination, file)
            _require_plain_directory_chain(
                destination.parent,
                "The model parent chain is not made of plain directories",
            )
            os.replace(temporary_path, destination)
            temporary_path = None
            _fsync_directory(destination.parent)
            return destination
        finally:
            if temporary_path is not None:
                _require_plain_directory_chain(
                    temporary_path.parent,
                    "The model staging parent chain is not made of plain directories",
                )
                try:
                    temporary_path.unlink(missing_ok=True)
                except OSError:
                    pass


def remove_staging_entry(staging: str | Path, entry_name: str) -> None:
    """Remove one direct child created inside a locked, fresh staging directory."""

    root = _absolute_lexical_path(Path(staging))
    _require_plain_directory_chain(
        root,
        "The model staging path or its parent chain is not made of plain directories",
    )
    relative = _safe_relative_path(entry_name)
    if len(relative.parts) != 1:
        raise ValueError("A staging cleanup entry must be a direct child")
    child = root / relative.name
    if _path_exists(child):
        _remove_scoped_path(child)


def _inventory_directory(
    root: Path,
    relative: PurePosixPath,
    files: set[str],
    directories: set[str],
) -> None:
    current = root if relative == PurePosixPath(".") else root.joinpath(*relative.parts)
    try:
        entries = list(os.scandir(current))
    except OSError as exc:
        raise ModelIntegrityError("The model directory could not be inspected") from exc
    for entry in entries:
        child_relative = PurePosixPath(entry.name) if relative == PurePosixPath(".") else relative / entry.name
        try:
            metadata = entry.stat(follow_symlinks=False)
        except OSError as exc:
            raise ModelIntegrityError("A model directory entry could not be inspected") from exc
        if _metadata_has_reparse(metadata) or stat.S_ISLNK(metadata.st_mode):
            raise ModelIntegrityError("The model directory contains a link or reparse point")
        if stat.S_ISREG(metadata.st_mode):
            files.add(child_relative.as_posix())
        elif stat.S_ISDIR(metadata.st_mode):
            directories.add(child_relative.as_posix())
            _inventory_directory(root, child_relative, files, directories)
        else:
            raise ModelIntegrityError("The model directory contains a non-regular entry")


def _fsync_manifest_tree(directory: Path, files: Sequence[ManifestFile]) -> None:
    directories: set[Path] = {directory}
    for item in files:
        relative = _safe_relative_path(item.path)
        path = directory.joinpath(*relative.parts)
        descriptor = os.open(
            path,
            os.O_RDWR | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0),
        )
        try:
            opened = os.fstat(descriptor)
            current = path.lstat()
            if (
                not _metadata_is_regular_without_reparse(opened)
                or not _metadata_is_regular_without_reparse(current)
                or not _same_file_metadata(opened, current)
            ):
                raise ModelIntegrityError("A model file changed before durable promotion")
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        directories.update(path.parents)
    for child in sorted(
        (path for path in directories if path == directory or directory in path.parents),
        key=lambda path: len(path.parts),
        reverse=True,
    ):
        _fsync_directory(child)


def _fsync_directory(directory: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _cleanup_sibling_staging(parent: Path, prefix: str) -> None:
    """Remove only bounded same-target staging entries; caller must hold the target lock."""

    _require_plain_directory_chain(
        parent,
        "The model staging parent chain is not made of plain directories",
    )

    try:
        entries = sorted(
            (entry for entry in parent.iterdir() if entry.name.startswith(prefix)),
            key=lambda path: path.name,
        )
    except OSError:
        return
    for entry in entries[:MAX_STAGING_ENTRIES_TO_REMOVE]:
        try:
            _remove_scoped_path(entry)
        except OSError:
            continue


def _remove_scoped_path(path: Path) -> None:
    metadata = path.lstat()
    if stat.S_ISDIR(metadata.st_mode) and not _metadata_has_reparse(metadata):
        with os.scandir(path) as entries:
            children = [Path(entry.path) for entry in entries]
        for child in children:
            _remove_scoped_path(child)
        path.rmdir()
        return
    if stat.S_ISDIR(metadata.st_mode):
        os.rmdir(path)
    else:
        path.unlink()


def _require_disk_space(directory: Path, required_bytes: int) -> None:
    try:
        free = shutil.disk_usage(directory).free
    except OSError as exc:
        raise ProvisioningError("Available model disk space could not be determined") from exc
    if free < required_bytes:
        raise InsufficientDiskSpaceError("There is not enough disk space for the verified model")


def _require_plain_directory(path: Path, message: str) -> None:
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise ModelIntegrityError(message) from exc
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or _metadata_has_reparse(metadata)
    ):
        raise ModelIntegrityError(message)


def _absolute_lexical_path(path: Path) -> Path:
    """Return an absolute path without resolving links or reparse points."""

    try:
        return Path(os.path.abspath(os.fspath(path)))
    except (OSError, TypeError, ValueError) as exc:
        raise ModelIntegrityError("A model path could not be normalized safely") from exc


def _directory_chain(path: Path) -> tuple[Path, ...]:
    """Build an anchor-first chain without attempting to create an OS root."""

    absolute = _absolute_lexical_path(path)
    anchor = absolute.anchor
    if not anchor:
        raise ModelIntegrityError("A model directory path has no filesystem anchor")
    current = Path(anchor)
    chain = [current]
    for part in absolute.parts[1:]:
        current = current / part
        chain.append(current)
    return tuple(chain)


def _require_plain_directory_chain(path: Path, message: str) -> Path:
    """Reject links, reparse points, files, and missing components in a chain."""

    chain = _directory_chain(path)
    for component in chain:
        _require_plain_directory(component, message)
    return chain[-1]


def _prepare_plain_directory_chain(path: Path, message: str) -> Path:
    """Create missing directories one at a time after validating every ancestor."""

    chain = _directory_chain(path)
    _require_plain_directory(chain[0], message)
    for component in chain[1:]:
        try:
            metadata = component.lstat()
        except FileNotFoundError:
            # The parent was validated in the prior iteration. Avoid parents=True,
            # which would otherwise follow an uninspected link higher in the chain.
            try:
                component.mkdir()
            except FileExistsError:
                # A concurrent creator won the race; validate what it created.
                pass
            except OSError as exc:
                raise ModelIntegrityError(message) from exc
        except OSError as exc:
            raise ModelIntegrityError(message) from exc
        else:
            if (
                not stat.S_ISDIR(metadata.st_mode)
                or stat.S_ISLNK(metadata.st_mode)
                or _metadata_has_reparse(metadata)
            ):
                raise ModelIntegrityError(message)
        _require_plain_directory(component, message)

    # Recheck the complete chain after creation so a changed ancestor cannot be
    # accepted merely because it was valid during an earlier iteration.
    return _require_plain_directory_chain(chain[-1], message)


def _safe_relative_path(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise ModelIntegrityError("A manifested model path is unsafe")
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value or any(part in {"", ".", ".."} for part in path.parts):
        raise ModelIntegrityError("A manifested model path is unsafe")
    return path


def _reject_duplicate_paths(paths: Sequence[PurePosixPath]) -> None:
    seen: set[str] = set()
    for path in paths:
        folded = path.as_posix().casefold()
        if folded in seen:
            raise ModelIntegrityError("The model file manifest contains duplicate paths")
        seen.add(folded)


def _path_exists(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise ProvisioningError("A model path could not be inspected") from exc
    return True


def _metadata_is_regular_without_reparse(metadata: os.stat_result) -> bool:
    return (
        stat.S_ISREG(metadata.st_mode)
        and not stat.S_ISLNK(metadata.st_mode)
        and not _metadata_has_reparse(metadata)
    )


def _metadata_has_reparse(metadata: os.stat_result) -> bool:
    return bool(getattr(metadata, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT)


def _same_file_metadata(left: os.stat_result, right: os.stat_result) -> bool:
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def _emit_progress(progress: ProgressCallback | None, phase: str) -> None:
    if progress is not None:
        progress(phase)


def _try_lock(descriptor: int) -> None:
    if os.name == "nt":
        import msvcrt

        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock(descriptor: int) -> None:
    if os.name == "nt":
        import msvcrt

        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(descriptor, fcntl.LOCK_UN)


def _is_busy_lock_error(exc: OSError) -> bool:
    if os.name == "nt":
        return exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK, 13, 36}
    return exc.errno in {errno.EACCES, errno.EAGAIN}
