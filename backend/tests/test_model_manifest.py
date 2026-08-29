from __future__ import annotations

import copy
from dataclasses import FrozenInstanceError
import json
from pathlib import Path
import tempfile
import unittest

from meeting_transcriber.model_manifest import (
    EXPECTED_ASR_MODEL_COUNT,
    EXPECTED_SPEAKER_MODEL_COUNT,
    EXPECTED_TRANSLATION_MODEL_COUNT,
    ManifestError,
    default_manifest_path,
    load_model_manifest,
)


class ModelManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.payload = json.loads(default_manifest_path().read_text(encoding="utf-8"))

    def test_bundled_manifest_is_complete_and_immutable(self) -> None:
        manifest = load_model_manifest()

        self.assertEqual(manifest.schema_version, 1)
        self.assertEqual(len(manifest.asr_models), EXPECTED_ASR_MODEL_COUNT)
        self.assertEqual(len(manifest.speaker_models), EXPECTED_SPEAKER_MODEL_COUNT)
        self.assertEqual(len(manifest.translation_models), EXPECTED_TRANSLATION_MODEL_COUNT)
        self.assertEqual(manifest.asr_model(manifest.default_asr_model).id, "small")
        self.assertRegex(manifest.asr_model("small").revision, r"^[0-9a-f]{40}$")
        self.assertRegex(manifest.speaker_model().file.sha256, r"^[0-9a-f]{64}$")
        translation = manifest.translation_model("en_to_pt_br")
        self.assertEqual(len(translation.source.members), 13)
        self.assertEqual(translation.conversion.version, "4.8.1")
        self.assertEqual(translation.conversion.target_token, ">>pob<<")
        with self.assertRaises(FrozenInstanceError):
            manifest.schema_version = 2  # type: ignore[misc]

    def test_duplicate_json_keys_are_rejected_before_schema_validation(self) -> None:
        text = default_manifest_path().read_text(encoding="utf-8")
        duplicated = text.replace(
            '"schema_version": 1,',
            '"schema_version": 1, "schema_version": 1,',
            1,
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_text(duplicated, encoding="utf-8")
            with self.assertRaisesRegex(ManifestError, "duplicate key"):
                load_model_manifest(path)

    def test_unknown_and_missing_fields_are_rejected_at_nested_boundaries(self) -> None:
        payload = copy.deepcopy(self.payload)
        payload["asr_models"][0]["mutable_branch"] = "main"
        with self.assertRaisesRegex(ManifestError, "unknown field"):
            self._load(payload)

        payload = copy.deepcopy(self.payload)
        del payload["speaker_models"][0]["revision"]
        with self.assertRaisesRegex(ManifestError, "missing field"):
            self._load(payload)

    def test_exact_model_and_translation_source_counts_are_enforced(self) -> None:
        payload = copy.deepcopy(self.payload)
        payload["asr_models"].pop()
        with self.assertRaisesRegex(ManifestError, "exactly 14"):
            self._load(payload)

        payload = copy.deepcopy(self.payload)
        payload["speaker_models"].append(copy.deepcopy(payload["speaker_models"][0]))
        with self.assertRaisesRegex(ManifestError, "exactly 1"):
            self._load(payload)

        payload = copy.deepcopy(self.payload)
        payload["translation_models"][0]["source"]["members"].pop()
        with self.assertRaisesRegex(ManifestError, "exactly 13"):
            self._load(payload)

    def test_duplicate_casefold_model_ids_and_file_paths_are_rejected(self) -> None:
        payload = copy.deepcopy(self.payload)
        payload["asr_models"][1]["id"] = payload["asr_models"][0]["id"]
        with self.assertRaisesRegex(ManifestError, "duplicate"):
            self._load(payload)

        payload = copy.deepcopy(self.payload)
        first_path = payload["asr_models"][0]["files"][0]["path"]
        payload["asr_models"][0]["files"][1]["path"] = first_path.upper()
        with self.assertRaisesRegex(ManifestError, "duplicate"):
            self._load(payload)

    def test_commit_hashes_sha256_digests_and_paths_are_canonical(self) -> None:
        payload = copy.deepcopy(self.payload)
        payload["asr_models"][0]["revision"] = "main"
        with self.assertRaisesRegex(ManifestError, "40-character"):
            self._load(payload)

        payload = copy.deepcopy(self.payload)
        payload["asr_models"][0]["files"][0]["sha256"] = "0" * 63
        with self.assertRaisesRegex(ManifestError, "64-character"):
            self._load(payload)

        for unsafe in ("../model.bin", "/model.bin", "nested\\model.bin", "C:/model.bin", "CON"):
            with self.subTest(unsafe=unsafe):
                payload = copy.deepcopy(self.payload)
                payload["asr_models"][0]["files"][0]["path"] = unsafe
                with self.assertRaisesRegex(ManifestError, "safe|Windows"):
                    self._load(payload)

    def test_translation_conversion_and_source_are_fixed(self) -> None:
        payload = copy.deepcopy(self.payload)
        payload["translation_models"][0]["source"]["url"] = "https://example.com/model.zip"
        with self.assertRaisesRegex(ManifestError, "fixed translation archive host"):
            self._load(payload)

        for unsafe_url in (
            "https://object.pouta.csc.fi:443/model.zip",
            "https://object.pouta.csc.fi/model.zip?mutable=1",
            "https://object.pouta.csc.fi:not-a-port/model.zip",
        ):
            with self.subTest(url=unsafe_url):
                payload = copy.deepcopy(self.payload)
                payload["translation_models"][0]["source"]["url"] = unsafe_url
                with self.assertRaisesRegex(ManifestError, "fixed translation archive host|invalid port"):
                    self._load(payload)

        payload = copy.deepcopy(self.payload)
        payload["translation_models"][0]["conversion"]["version"] = "4.9.0"
        with self.assertRaisesRegex(ManifestError, "4.8.1"):
            self._load(payload)

        payload = copy.deepcopy(self.payload)
        payload["translation_models"][0]["conversion"]["target_token"] = ">>por<<"
        with self.assertRaisesRegex(ManifestError, "pob"):
            self._load(payload)

    def _load(self, payload: object) -> object:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            return load_model_manifest(path)


if __name__ == "__main__":
    unittest.main()
