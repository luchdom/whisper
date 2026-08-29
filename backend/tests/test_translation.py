from __future__ import annotations

import hashlib
import io
from pathlib import Path
import stat
import struct
from types import SimpleNamespace
import tempfile
import unittest
import warnings
import zipfile

from meeting_transcriber import translation
from meeting_transcriber.translation import (
    LocalCTranslate2Translator,
    TranslationError,
    TranslationUnavailableError,
)


def file_spec(path: str, data: bytes, *, extract: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        path=path,
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        extract=extract,
    )


def make_zip(entries: list[tuple[str, bytes, int | None]]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        for name, data, mode in entries:
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            if mode is not None:
                info.create_system = 3
                info.external_attr = mode << 16
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", message="Duplicate name:")
                archive.writestr(info, data)
    return output.getvalue()


class FakeResponse(io.BytesIO):
    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def geturl(self) -> str:
        return "https://object.pouta.csc.fi/model.zip"


class FakeSentencePiece:
    def __init__(self, encoded: list[str] | None = None) -> None:
        self.encoded = encoded
        self.loaded = None
        self.encoded_text = None
        self.decoded = None

    def load(self, path: str) -> bool:
        self.loaded = path
        return True

    def encode(self, text: str, *, out_type: type[str]) -> list[str]:
        self.encoded_text = text
        self.out_type = out_type
        return list(self.encoded or [])

    def decode(self, pieces: list[str]) -> str:
        self.decoded = list(pieces)
        return "Tradução local"


class FakeRuntime:
    def __init__(self, output_pieces: list[str] | None = None) -> None:
        self.output_pieces = output_pieces or ["Tradução", " local"]
        self.calls = []

    def translate_batch(self, batch, **kwargs):  # type: ignore[no-untyped-def]
        self.calls.append((batch, kwargs))
        return [SimpleNamespace(hypotheses=[self.output_pieces])]


class TranslationTests(unittest.TestCase):
    def test_archive_inspection_verifies_all_members_and_extracts_only_allowlisted_inputs(self) -> None:
        contents = {
            "source.spm": b"source",
            "target.spm": b"target",
            "decoder.yml": b"models: [model.npz]",
            "model.npz": b"model",
            "vocab.yml": b"vocab",
            "README.md": b"readme",
            "LICENSE": b"license",
            "unused-1": b"one",
            "unused-2": b"two",
            "unused-3": b"three",
            "unused-4": b"four",
            "unused-5": b"five",
            "unused-6": b"six",
        }
        members = tuple(
            file_spec(name, data, extract=not name.startswith("unused"))
            for name, data in contents.items()
        )
        archive_bytes = make_zip(
            [(name, data, stat.S_IFREG | 0o600) for name, data in contents.items()]
        )
        spec = SimpleNamespace(source=SimpleNamespace(members=members))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive_path = root / "source.zip"
            target = root / "extracted"
            archive_path.write_bytes(archive_bytes)
            target.mkdir()

            translation._inspect_and_extract_archive(archive_path, target, spec)

            self.assertEqual(
                sorted(path.name for path in target.iterdir()),
                sorted(name for name in contents if not name.startswith("unused")),
            )
            self.assertEqual((target / "source.spm").read_bytes(), b"source")

    def test_archive_rejects_duplicates_case_collisions_unsafe_paths_and_symlinks(self) -> None:
        scenarios = {
            "duplicate": [("same", b"a", None), ("same", b"a", None)],
            "case": [("same", b"a", None), ("SAME", b"a", None)],
            "traversal": [("../same", b"a", None)],
            "absolute": [("/same", b"a", None)],
            "drive": [("C:/same", b"a", None)],
            "unc": [("//server/share", b"a", None)],
            "backslash": [("dir\\same", b"a", None)],
            "symlink": [("same", b"a", stat.S_IFLNK | 0o777)],
        }
        for name, entries in scenarios.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive_path = root / "source.zip"
                archive_path.write_bytes(make_zip(entries))
                members = tuple(file_spec(path, data) for path, data, _mode in entries)
                # Duplicate/case-collision manifests are deliberately normalized to
                # one expected entry so the archive itself remains the rejected input.
                if name in {"duplicate", "case"}:
                    members = (file_spec("same", b"a"),)
                spec = SimpleNamespace(source=SimpleNamespace(members=members))
                target = root / "target"
                target.mkdir()
                with self.assertRaises(TranslationError):
                    translation._inspect_and_extract_archive(archive_path, target, spec)
                self.assertEqual(list(target.iterdir()), [])

    def test_archive_rejects_encryption_unsupported_compression_size_and_hash_violations(self) -> None:
        base = make_zip([("same", b"payload", stat.S_IFREG | 0o600)])

        encrypted = bytearray(base)
        local = encrypted.find(b"PK\x03\x04")
        central = encrypted.find(b"PK\x01\x02")
        self.assertGreaterEqual(local, 0)
        self.assertGreaterEqual(central, 0)
        struct.pack_into("<H", encrypted, local + 6, struct.unpack_from("<H", encrypted, local + 6)[0] | 0x40)
        struct.pack_into(
            "<H",
            encrypted,
            central + 8,
            struct.unpack_from("<H", encrypted, central + 8)[0] | 0x40,
        )

        unsupported = io.BytesIO()
        with zipfile.ZipFile(unsupported, "w", compression=zipfile.ZIP_BZIP2) as archive:
            archive.writestr("same", b"payload")

        valid_member = file_spec("same", b"payload")
        bad_size = SimpleNamespace(
            path="same",
            size=valid_member.size + 1,
            sha256=valid_member.sha256,
            extract=True,
        )
        bad_hash = SimpleNamespace(
            path="same",
            size=valid_member.size,
            sha256="0" * 64,
            extract=True,
        )
        scenarios = (
            (bytes(encrypted), valid_member),
            (unsupported.getvalue(), valid_member),
            (base, bad_size),
            (base, bad_hash),
        )
        for archive_bytes, member in scenarios:
            with self.subTest(member=member), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive_path = root / "source.zip"
                target = root / "target"
                archive_path.write_bytes(archive_bytes)
                target.mkdir()
                spec = SimpleNamespace(source=SimpleNamespace(members=(member,)))
                with self.assertRaises(TranslationError):
                    translation._inspect_and_extract_archive(archive_path, target, spec)

    def test_deterministic_conversion_is_verified_and_promotes_only_manifest_outputs(self) -> None:
        extracted_contents = {
            "README.md": b"readme",
            "LICENSE": b"license",
            "source.spm": b"source",
            "target.spm": b"target",
            "decoder.yml": b"decoder",
            "model.npz": b"npz",
            "vocab.yml": b"vocab",
            "ignored-1": b"1",
            "ignored-2": b"2",
            "ignored-3": b"3",
            "ignored-4": b"4",
            "ignored-5": b"5",
            "ignored-6": b"6",
        }
        archive = make_zip([
            (name, data, stat.S_IFREG | 0o600)
            for name, data in extracted_contents.items()
        ])
        converted_contents = {
            "config.json": b"config",
            "model.bin": b"converted",
            "shared_vocabulary.json": b"vocabulary",
            "README.md": b"readme",
            "LICENSE": b"license",
            "source.spm": b"source",
            "target.spm": b"target",
        }
        source_members = tuple(
            file_spec(name, data, extract=not name.startswith("ignored"))
            for name, data in extracted_contents.items()
        )
        source = SimpleNamespace(
            url=(
                "https://object.pouta.csc.fi/Tatoeba-MT-models/eng-por/"
                "opusTCv20210807+bt_transformer-big_2022-03-13.zip"
            ),
            size=len(archive),
            sha256=hashlib.sha256(archive).hexdigest(),
            members=source_members,
        )
        conversion = SimpleNamespace(
            quantization="int8",
            target_token=">>pob<<",
            files=tuple(file_spec(name, data) for name, data in converted_contents.items()),
        )
        spec = SimpleNamespace(source=source, conversion=conversion)

        class Converter:
            def convert(self, output_dir: str, **kwargs: object) -> None:
                self.kwargs = kwargs
                root = Path(output_dir)
                if root.exists():
                    raise RuntimeError("the converter must own output-directory creation")
                root.mkdir()
                for filename in ("config.json", "model.bin", "shared_vocabulary.json"):
                    (root / filename).write_bytes(converted_contents[filename])

        translator = LocalCTranslate2Translator(
            Path.cwd(),
            opener=lambda *_args, **_kwargs: FakeResponse(archive),
            converter_factory=lambda _directory: Converter(),
            platform_key="win32-x64",
        )
        phases: list[str] = []
        translator.set_progress_sink(phases.append)
        with tempfile.TemporaryDirectory() as directory:
            staging = Path(directory)
            translator._build_verified_model(staging, spec)  # type: ignore[arg-type]
            self.assertEqual(
                sorted(path.name for path in staging.iterdir()),
                sorted(converted_contents),
            )
            self.assertEqual((staging / "model.bin").read_bytes(), b"converted")
        self.assertEqual(
            phases,
            ["downloading_translation", "verifying_translation", "converting_translation"],
        )

    def test_platform_gate_fails_before_provisioning(self) -> None:
        spec = SimpleNamespace(id="translation", platforms=("win32-x64",))
        manifest = SimpleNamespace(translation_model=lambda _mode: spec)
        provisioned = []
        translator = LocalCTranslate2Translator(
            Path.cwd(),
            manifest_provider=lambda: manifest,
            directory_provisioner=lambda **kwargs: provisioned.append(kwargs),
            platform_key="darwin-arm64",
        )
        with self.assertRaises(TranslationUnavailableError):
            translator.prepare()
        self.assertEqual(provisioned, [])

    def test_target_token_is_a_separate_piece_and_exact_512_piece_input_is_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prepared = root / "translation"
            prepared.mkdir()
            (prepared / "source.spm").touch()
            (prepared / "target.spm").touch()
            source_sp = FakeSentencePiece([f"piece-{index}" for index in range(511)])
            target_sp = FakeSentencePiece()
            processors = iter((source_sp, target_sp))
            runtime = FakeRuntime()
            spec = SimpleNamespace(
                id="translation",
                platforms=("win32-x64",),
                source=SimpleNamespace(size=1, members=()),
                conversion=SimpleNamespace(target_token=">>pob<<", files=()),
            )
            manifest = SimpleNamespace(translation_model=lambda _mode: spec)
            translator = LocalCTranslate2Translator(
                root,
                manifest_provider=lambda: manifest,
                directory_provisioner=lambda **_kwargs: prepared,
                runtime_factory=lambda _path: runtime,
                sentencepiece_factory=lambda: next(processors),
                platform_key="win32-x64",
            )

            result = translator.translate("English source")

            self.assertEqual(result, "Tradução local")
            self.assertEqual(source_sp.encoded_text, "English source")
            batch, kwargs = runtime.calls[0]
            self.assertEqual(len(batch), 1)
            self.assertEqual(len(batch[0]), 512)
            self.assertEqual(batch[0][0], ">>pob<<")
            self.assertEqual(batch[0][1], "piece-0")
            self.assertEqual(kwargs["max_batch_size"], 1)
            self.assertEqual(kwargs["max_decoding_length"], 512)

    def test_more_than_512_source_pieces_and_oversize_text_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prepared = root / "translation"
            prepared.mkdir()
            (prepared / "source.spm").touch()
            (prepared / "target.spm").touch()
            source_sp = FakeSentencePiece(["piece"] * 512)
            target_sp = FakeSentencePiece()
            processors = iter((source_sp, target_sp))
            runtime = FakeRuntime()
            spec = SimpleNamespace(
                id="translation",
                platforms=("win32-x64",),
                source=SimpleNamespace(size=1, members=()),
                conversion=SimpleNamespace(target_token=">>pob<<", files=()),
            )
            translator = LocalCTranslate2Translator(
                root,
                manifest_provider=lambda: SimpleNamespace(translation_model=lambda _mode: spec),
                directory_provisioner=lambda **_kwargs: prepared,
                runtime_factory=lambda _path: runtime,
                sentencepiece_factory=lambda: next(processors),
                platform_key="win32-x64",
            )
            with self.assertRaisesRegex(TranslationError, "piece limit"):
                translator.translate("English")
            with self.assertRaisesRegex(TranslationError, "too long"):
                translator.translate("x" * 4_001)
            self.assertEqual(runtime.calls, [])


if __name__ == "__main__":
    unittest.main()
