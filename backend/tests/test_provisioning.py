from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import stat
import subprocess
import sys
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from meeting_transcriber.model_manifest import ManifestFile
from meeting_transcriber.provisioning import (
    CrossProcessFileLock,
    InsufficientDiskSpaceError,
    ModelIntegrityError,
    ProvisioningLockTimeout,
    download_verified_file,
    provision_directory,
    verify_directory,
    verify_file,
    _normalize_darwin_system_directory_alias,
)


class FakeResponse(io.BytesIO):
    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


def declared(path: str, data: bytes) -> ManifestFile:
    return ManifestFile(path=path, size=len(data), sha256=hashlib.sha256(data).hexdigest())


class ProvisioningTests(unittest.TestCase):
    def test_darwin_temp_alias_normalization_is_exact_and_fail_closed(self) -> None:
        symlink_metadata = SimpleNamespace(st_mode=stat.S_IFLNK, st_dev=1, st_ino=2)
        aliases = {
            Path("/var"): "private/var",
            Path("/tmp"): "private/tmp",
        }

        with (
            patch("meeting_transcriber.provisioning.sys.platform", "darwin"),
            patch.object(Path, "lstat", autospec=True, return_value=symlink_metadata),
            patch(
                "meeting_transcriber.provisioning.os.readlink",
                side_effect=lambda value: aliases[Path(value)],
            ),
        ):
            self.assertEqual(
                _normalize_darwin_system_directory_alias(Path("/var/folders/test/model")),
                Path("/private/var/folders/test/model"),
            )
            self.assertEqual(
                _normalize_darwin_system_directory_alias(Path("/tmp/test/model")),
                Path("/private/tmp/test/model"),
            )

        for hostile_target in (
            "attacker",
            "/private/var",
            "private/var/",
            "./private/var",
            "private/redirect/../var",
            "private/var-other",
        ):
            with self.subTest(hostile_target=hostile_target):
                with (
                    patch("meeting_transcriber.provisioning.sys.platform", "darwin"),
                    patch.object(Path, "lstat", autospec=True, return_value=symlink_metadata),
                    patch(
                        "meeting_transcriber.provisioning.os.readlink",
                        return_value=hostile_target,
                    ),
                ):
                    original = Path("/var/folders/test/model")
                    self.assertEqual(_normalize_darwin_system_directory_alias(original), original)

        changed_metadata = SimpleNamespace(st_mode=stat.S_IFLNK, st_dev=1, st_ino=3)
        with (
            patch("meeting_transcriber.provisioning.sys.platform", "darwin"),
            patch.object(
                Path,
                "lstat",
                autospec=True,
                side_effect=[symlink_metadata, changed_metadata],
            ),
            patch("meeting_transcriber.provisioning.os.readlink", return_value="private/var"),
        ):
            original = Path("/var/folders/test/model")
            self.assertEqual(_normalize_darwin_system_directory_alias(original), original)

    @unittest.skipUnless(sys.platform == "darwin", "macOS fixed system alias coverage")
    def test_macos_fixed_temp_aliases_support_verified_files(self) -> None:
        data = b"verified"
        spec = declared("model.bin", data)
        for temporary_parent in ("/var/tmp", "/tmp"):
            with self.subTest(temporary_parent=temporary_parent):
                with tempfile.TemporaryDirectory(dir=temporary_parent) as directory:
                    target = Path(directory) / "model.bin"
                    target.write_bytes(data)
                    self.assertEqual(verify_file(target, spec), target.resolve(strict=True))

    def test_verify_directory_requires_exact_regular_files_and_hashes(self) -> None:
        config = b'{"model":"test"}'
        model = b"model-bytes"
        files = (declared("config.json", config), declared("weights/model.bin", model))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(strict=True) / "model"
            (root / "weights").mkdir(parents=True)
            (root / "config.json").write_bytes(config)
            (root / "weights" / "model.bin").write_bytes(model)
            self.assertEqual(verify_directory(root, files), root)

            (root / "unexpected.txt").write_text("unexpected", encoding="utf-8")
            with self.assertRaisesRegex(ModelIntegrityError, "exactly"):
                verify_directory(root, files)
            (root / "unexpected.txt").unlink()

            (root / "weights" / "model.bin").write_bytes(b"Model-bytes")
            with self.assertRaisesRegex(ModelIntegrityError, "SHA-256"):
                verify_directory(root, files)

    def test_verify_file_rejects_symlinks_when_supported(self) -> None:
        data = b"verified"
        spec = declared("model.bin", data)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(strict=True)
            real = root / "real.bin"
            link = root / "model.bin"
            real.write_bytes(data)
            try:
                os.symlink(real, link)
            except OSError as exc:
                self.skipTest(f"Symlink creation is unavailable: {exc}")
            with self.assertRaisesRegex(ModelIntegrityError, "regular file"):
                verify_file(link, spec)

    def test_verify_file_rejects_windows_reparse_metadata(self) -> None:
        data = b"verified"
        spec = declared("model.bin", data)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory).resolve(strict=True) / "model.bin"
            target.write_bytes(data)
            target_metadata = target.lstat()

            def has_target_reparse(metadata: os.stat_result) -> bool:
                return (
                    metadata.st_dev == target_metadata.st_dev
                    and metadata.st_ino == target_metadata.st_ino
                )

            with patch(
                "meeting_transcriber.provisioning._metadata_has_reparse",
                side_effect=has_target_reparse,
            ):
                with self.assertRaisesRegex(ModelIntegrityError, "regular file"):
                    verify_file(target, spec)

    def test_directory_provisioning_is_locked_verified_and_atomically_promoted(self) -> None:
        config = b"config"
        model = b"model"
        files = (declared("config.json", config), declared("nested/model.bin", model))
        phases: list[str] = []
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory).resolve(strict=True) / "asr" / "test-model"
            target.parent.mkdir()
            abandoned = target.parent / f".{target.name}.staging-abandoned"
            abandoned.mkdir()
            (abandoned / "partial").write_bytes(b"partial")

            def fetch(staging: Path) -> None:
                self.assertFalse(target.exists())
                self.assertEqual(staging.parent, target.parent)
                (staging / "nested").mkdir()
                (staging / "config.json").write_bytes(config)
                (staging / "nested" / "model.bin").write_bytes(model)

            result = provision_directory(
                target=target,
                files=files,
                fetch_to_staging=fetch,
                progress=phases.append,
            )
            self.assertEqual(result, target)
            self.assertEqual(phases, ["verifying"])
            self.assertFalse(abandoned.exists())
            self.assertTrue((target.parent / f".{target.name}.lock").is_file())
            self.assertEqual(list(target.parent.glob(f".{target.name}.staging-*")), [])
            self.assertEqual(verify_directory(target, files), target)

    @unittest.skipIf(os.name == "nt", "POSIX ancestor symlink coverage")
    def test_provisioning_rejects_symlink_in_destination_parent_chain(self) -> None:
        files = (declared("model.bin", b"model"),)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(strict=True)
            redirected = root / "redirected"
            redirected.mkdir()
            redirected_staging = redirected / ".model.staging-must-remain"
            redirected_staging.mkdir()
            linked_parent = root / "models"
            os.symlink(redirected, linked_parent, target_is_directory=True)
            target = linked_parent / "nested" / "model"
            fetched = False

            def fetch(_staging: Path) -> None:
                nonlocal fetched
                fetched = True

            with self.assertRaisesRegex(ModelIntegrityError, "parent chain"):
                provision_directory(target=target, files=files, fetch_to_staging=fetch)

            self.assertFalse(fetched)
            self.assertFalse((redirected / "nested").exists())
            self.assertTrue(redirected_staging.is_dir())

    def test_provisioning_rejects_injected_windows_reparse_ancestor(self) -> None:
        files = (declared("model.bin", b"model"),)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(strict=True)
            hostile_parent = root / "models"
            hostile_parent.mkdir()
            target = hostile_parent / "nested" / "model"
            hostile_staging = hostile_parent / ".model.staging-must-remain"
            hostile_staging.mkdir()
            original_lstat = Path.lstat
            hostile_key = os.path.normcase(os.path.abspath(hostile_parent))
            fetched = False

            def lstat_with_injected_reparse(path: Path):  # type: ignore[no-untyped-def]
                metadata = original_lstat(path)
                if os.path.normcase(os.path.abspath(path)) != hostile_key:
                    return metadata
                return SimpleNamespace(
                    st_mode=metadata.st_mode,
                    st_file_attributes=(
                        getattr(metadata, "st_file_attributes", 0) | 0x0400
                    ),
                )

            def fetch(_staging: Path) -> None:
                nonlocal fetched
                fetched = True

            with patch.object(Path, "lstat", autospec=True, side_effect=lstat_with_injected_reparse):
                with self.assertRaisesRegex(ModelIntegrityError, "parent chain"):
                    provision_directory(target=target, files=files, fetch_to_staging=fetch)

            self.assertFalse(fetched)
            self.assertFalse((hostile_parent / "nested").exists())
            self.assertTrue(hostile_staging.is_dir())

    def test_provisioning_rejects_non_directory_ancestor_before_creation(self) -> None:
        files = (declared("model.bin", b"model"),)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(strict=True)
            hostile_parent = root / "models"
            hostile_parent.write_bytes(b"not-a-directory")
            target = hostile_parent / "nested" / "model"

            with self.assertRaisesRegex(ModelIntegrityError, "parent chain"):
                provision_directory(
                    target=target,
                    files=files,
                    fetch_to_staging=lambda _path: self.fail("must reject before fetching"),
                )

    def test_verified_cache_is_rechecked_and_corruption_never_triggers_overwrite(self) -> None:
        data = b"verified"
        files = (declared("model.bin", data),)
        fetches = 0
        phases: list[str] = []
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory).resolve(strict=True) / "model"

            def fetch(staging: Path) -> None:
                nonlocal fetches
                fetches += 1
                (staging / "model.bin").write_bytes(data)

            provision_directory(target=target, files=files, fetch_to_staging=fetch)
            self.assertEqual(
                provision_directory(
                    target=target,
                    files=files,
                    fetch_to_staging=lambda _path: self.fail("cache hit must not fetch"),
                    progress=phases.append,
                ),
                target,
            )
            self.assertEqual(fetches, 1)
            self.assertEqual(phases, ["verifying"])

            (target / "model.bin").write_bytes(b"Verifyed")
            with self.assertRaisesRegex(ModelIntegrityError, "SHA-256"):
                provision_directory(
                    target=target,
                    files=files,
                    fetch_to_staging=lambda _path: self.fail("corruption must fail closed"),
                )
            self.assertEqual(fetches, 1)

    def test_failed_fetch_removes_only_same_target_staging(self) -> None:
        files = (declared("model.bin", b"model"),)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(strict=True)
            target = root / "model"
            unrelated = root / ".another-model.staging-preserve"
            unrelated.mkdir()

            def fail(staging: Path) -> None:
                (staging / "partial").write_bytes(b"partial")
                raise RuntimeError("download failed")

            with self.assertRaisesRegex(RuntimeError, "download failed"):
                provision_directory(target=target, files=files, fetch_to_staging=fail)
            self.assertFalse(target.exists())
            self.assertTrue(unrelated.exists())
            self.assertEqual(list(root.glob(f".{target.name}.staging-*")), [])

    def test_disk_preflight_happens_before_fetch(self) -> None:
        files = (declared("model.bin", b"model"),)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory).resolve(strict=True) / "model"
            with patch(
                "meeting_transcriber.provisioning.shutil.disk_usage",
                return_value=SimpleNamespace(free=4),
            ):
                with self.assertRaisesRegex(InsufficientDiskSpaceError, "disk space"):
                    provision_directory(
                        target=target,
                        files=files,
                        fetch_to_staging=lambda _path: self.fail("must fail before fetching"),
                        required_bytes=5,
                    )

    def test_second_lock_attempt_observes_bounded_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lock_path = Path(directory).resolve(strict=True) / ".model.lock"
            with CrossProcessFileLock(lock_path):
                with self.assertRaisesRegex(ProvisioningLockTimeout, "Timed out"):
                    with CrossProcessFileLock(lock_path, timeout_seconds=0):
                        self.fail("the second lock must not be acquired")

    def test_lock_contention_is_observed_by_another_process(self) -> None:
        child_code = """
from meeting_transcriber.provisioning import CrossProcessFileLock, ProvisioningLockTimeout
import sys
try:
    with CrossProcessFileLock(sys.argv[1], timeout_seconds=0.2, poll_interval_seconds=0.02):
        pass
except ProvisioningLockTimeout:
    raise SystemExit(23)
raise SystemExit(0)
"""
        with tempfile.TemporaryDirectory() as directory:
            lock_path = Path(directory).resolve(strict=True) / ".model.lock"
            with CrossProcessFileLock(lock_path):
                result = subprocess.run(
                    [sys.executable, "-B", "-c", child_code, str(lock_path)],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
            self.assertEqual(result.returncode, 23, result.stderr)

    def test_lock_timing_parameters_are_finite_and_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lock_path = Path(directory).resolve(strict=True) / ".model.lock"
            for invalid in (float("nan"), float("inf"), 301):
                with self.subTest(timeout=invalid), self.assertRaisesRegex(ValueError, "finite"):
                    CrossProcessFileLock(lock_path, timeout_seconds=invalid)
            for invalid in (float("nan"), float("inf"), 11):
                with self.subTest(poll=invalid), self.assertRaisesRegex(ValueError, "finite"):
                    CrossProcessFileLock(lock_path, poll_interval_seconds=invalid)

    def test_single_file_download_is_exact_atomic_and_never_replaces_corruption(self) -> None:
        data = b"speaker-model"
        spec = declared("speaker.onnx", data)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory).resolve(strict=True) / "models" / "speaker.onnx"
            self.assertEqual(
                download_verified_file(
                    target=target,
                    file=spec,
                    url="https://example.invalid/speaker.onnx",
                    opener=lambda *_args, **_kwargs: FakeResponse(data),
                ),
                target,
            )
            self.assertEqual(target.read_bytes(), data)
            self.assertEqual(list(target.parent.glob(f".{target.name}.staging-*")), [])

            target.write_bytes(b"speaker-Model")
            with self.assertRaisesRegex(ModelIntegrityError, "integrity"):
                download_verified_file(
                    target=target,
                    file=spec,
                    url="https://example.invalid/speaker.onnx",
                    opener=lambda *_args, **_kwargs: self.fail("corruption must not redownload"),
                )

            target.unlink()
            with self.assertRaisesRegex(ModelIntegrityError, "size cap"):
                download_verified_file(
                    target=target,
                    file=spec,
                    url="https://example.invalid/speaker.onnx",
                    opener=lambda *_args, **_kwargs: FakeResponse(data + b"x"),
                )
            self.assertFalse(target.exists())
            self.assertEqual(list(target.parent.glob(f".{target.name}.staging-*")), [])


if __name__ == "__main__":
    unittest.main()
