from __future__ import annotations

from dataclasses import replace
import hashlib
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from meeting_transcriber.engine import EngineSettings, FasterWhisperEngine, ModelLoadProgress
from meeting_transcriber.model_manifest import ManifestFile, get_model_manifest
from meeting_transcriber.segmentation import InferenceJob


MODEL_FILES = {
    "config.json": b"config",
    "model.bin": b"model",
    "tokenizer.json": b"tokenizer",
    "vocabulary.txt": b"vocabulary",
}


def test_manifest(*model_ids: str):
    manifest = get_model_manifest()
    replaced_models = []
    for model in manifest.asr_models:
        if model.id in model_ids:
            files = tuple(
                ManifestFile(path=name, size=len(data), sha256=hashlib.sha256(data).hexdigest())
                for name, data in MODEL_FILES.items()
            )
            model = replace(model, files=files)
        replaced_models.append(model)
    return replace(manifest, asr_models=tuple(replaced_models))


def inference_job() -> InferenceJob:
    return InferenceJob(
        session_id="session",
        segment_id="segment",
        revision=1,
        start_ms=0,
        end_ms=1,
        track="system",
        pcm_s16le=b"\0\0" * 16,
        final=True,
    )


class EngineTests(unittest.TestCase):
    def test_language_diarization_and_translation_changes_do_not_reload_asr(self) -> None:
        loads: list[tuple[str, dict[str, object]]] = []
        downloads: list[tuple[str, dict[str, object]]] = []
        manifest = test_manifest("small.en", "tiny")
        payloads = {
            manifest.asr_model(model_id).repository: MODEL_FILES
            for model_id in ("small.en", "tiny")
        }

        class WhisperModel:
            def __init__(self, model: str, **kwargs: object) -> None:
                loads.append((model, kwargs))

        fake_module, fake_utils = self._fake_faster_whisper(WhisperModel, downloads, payloads)
        with tempfile.TemporaryDirectory() as directory:
            engine = FasterWhisperEngine(manifest_provider=lambda: manifest)
            with patch.dict(
                sys.modules,
                {"faster_whisper": fake_module, "faster_whisper.utils": fake_utils},
            ):
                engine.configure(
                    EngineSettings(
                        model="small.en",
                        language="en",
                        device="cpu",
                        compute="int8",
                        download_root=directory,
                    )
                )
                engine.prepare()
                engine.configure(
                    EngineSettings(
                        model="small.en",
                        language="pt",
                        device="cpu",
                        compute="int8",
                        download_root=directory,
                        diarization="online",
                        diarization_model="C:/models/speaker.onnx",
                        translation="en_to_pt_br",
                        translation_model="C:/models/translation",
                    )
                )
                engine.prepare()
                self.assertEqual(len(loads), 1)

                engine.configure(
                    EngineSettings(
                        model="tiny",
                        language="pt",
                        device="cpu",
                        compute="int8",
                        download_root=directory,
                    )
                )
                engine.prepare()

        self.assertEqual(
            [repository for repository, _kwargs in downloads],
            [manifest.asr_model("small.en").repository, manifest.asr_model("tiny").repository],
        )
        self.assertEqual(len(loads), 2)
        self.assertTrue(all(Path(model).is_absolute() for model, _kwargs in loads))
        self.assertTrue(all(kwargs["local_files_only"] for _model, kwargs in loads))
        for repository, kwargs in downloads:
            matching = next(model for model in manifest.asr_models if model.repository == repository)
            self.assertEqual(kwargs["revision"], matching.revision)
            self.assertIn(f"{matching.id}-{matching.revision}", str(kwargs["output_dir"]))
            self.assertNotIn("local_files_only", kwargs)

    def test_missing_model_uses_pinned_staging_then_cached_start_reverifies(self) -> None:
        progress: list[str] = []
        downloads: list[tuple[str, dict[str, object]]] = []
        loads: list[tuple[str, dict[str, object]]] = []
        manifest = test_manifest("small.en")
        spec = manifest.asr_model("small.en")

        class WhisperModel:
            def __init__(self, model: str, **kwargs: object) -> None:
                loads.append((model, kwargs))

        fake_module, fake_utils = self._fake_faster_whisper(
            WhisperModel, downloads, {spec.repository: MODEL_FILES}
        )
        with tempfile.TemporaryDirectory() as directory:
            engine = FasterWhisperEngine(
                lambda event: progress.append(event.phase), manifest_provider=lambda: manifest
            )
            engine.configure(
                EngineSettings(
                    model="small.en",
                    device="cpu",
                    compute="int8",
                    download_root=directory,
                )
            )
            with patch.dict(
                sys.modules,
                {"faster_whisper": fake_module, "faster_whisper.utils": fake_utils},
            ):
                engine.prepare()
                self.assertEqual(
                    progress,
                    ["checking_cache", "downloading", "verifying", "initializing"],
                )
                progress.clear()
                engine.prepare()

            self.assertEqual(progress, ["checking_cache", "verifying"])
            self.assertEqual(len(downloads), 1)
            self.assertEqual(downloads[0][0], spec.repository)
            self.assertEqual(downloads[0][1]["revision"], spec.revision)
            self.assertEqual(len(loads), 1)
            prepared = Path(loads[0][0])
            self.assertEqual(prepared.parent, Path(directory).resolve(strict=True))
            self.assertFalse((prepared / ".cache").exists())

    def test_corrupt_cache_fails_closed_without_redownload_or_model_construction(self) -> None:
        downloads: list[tuple[str, dict[str, object]]] = []
        loads: list[tuple[str, dict[str, object]]] = []
        manifest = test_manifest("small")
        spec = manifest.asr_model("small")

        class WhisperModel:
            def __init__(self, model: str, **kwargs: object) -> None:
                loads.append((model, kwargs))

        fake_module, fake_utils = self._fake_faster_whisper(
            WhisperModel, downloads, {spec.repository: MODEL_FILES}
        )
        with tempfile.TemporaryDirectory() as directory:
            engine = FasterWhisperEngine(manifest_provider=lambda: manifest)
            engine.configure(EngineSettings(model="small", download_root=directory))
            with patch.dict(
                sys.modules,
                {"faster_whisper": fake_module, "faster_whisper.utils": fake_utils},
            ):
                engine.prepare()
                prepared = Path(loads[0][0])
                (prepared / "model.bin").write_bytes(b"Model")
                with self.assertRaisesRegex(Exception, "SHA-256"):
                    engine.prepare()

            self.assertEqual(len(downloads), 1)
            self.assertEqual(len(loads), 1)

    def test_unknown_or_local_path_model_is_rejected_by_public_manifest_id(self) -> None:
        engine = FasterWhisperEngine(manifest_provider=get_model_manifest)
        engine.configure(EngineSettings(model="C:/private/unmanifested-model"))
        with self.assertRaisesRegex(Exception, "not in the immutable manifest"):
            engine.prepare()

    def test_transcribe_reports_detected_language_probability(self) -> None:
        downloads: list[tuple[str, dict[str, object]]] = []
        manifest = test_manifest("tiny")
        spec = manifest.asr_model("tiny")

        class Segment:
            text = " translated input "

        class WhisperModel:
            def __init__(self, _model: str, **_kwargs: object) -> None:
                pass

            def transcribe(self, _audio: object, **_kwargs: object):
                return [Segment()], SimpleNamespace(language="en", language_probability=0.875)

        fake_module, fake_utils = self._fake_faster_whisper(
            WhisperModel, downloads, {spec.repository: MODEL_FILES}
        )
        with tempfile.TemporaryDirectory() as directory:
            engine = FasterWhisperEngine(manifest_provider=lambda: manifest)
            engine.configure(EngineSettings(model="tiny", download_root=directory))
            with patch.dict(
                sys.modules,
                {"faster_whisper": fake_module, "faster_whisper.utils": fake_utils},
            ):
                engine.prepare()
            result = engine.transcribe(inference_job(), None)
        self.assertEqual(result.text, "translated input")
        self.assertEqual(result.language, "en")
        self.assertEqual(result.language_probability, 0.875)

    def test_engine_settings_and_progress_phases_validate_translation_contract(self) -> None:
        with self.assertRaisesRegex(ValueError, "off.*online"):
            EngineSettings(diarization="remote")
        with self.assertRaisesRegex(ValueError, "local path"):
            EngineSettings(diarization_model="bad\x00path")
        with self.assertRaisesRegex(ValueError, "off.*en_to_pt_br"):
            EngineSettings(translation="remote")
        with self.assertRaisesRegex(ValueError, "local path"):
            EngineSettings(translation_model="bad\x00path")
        for phase in (
            "verifying",
            "checking_translation_cache",
            "downloading_translation",
            "verifying_translation",
            "converting_translation",
            "initializing_translation",
        ):
            self.assertEqual(ModelLoadProgress(phase).phase, phase)
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            ModelLoadProgress("mutable_download")

    @staticmethod
    def _fake_faster_whisper(
        whisper_model: type,
        downloads: list[tuple[str, dict[str, object]]],
        payloads: dict[str, dict[str, bytes]],
    ) -> tuple[types.ModuleType, types.ModuleType]:
        fake_module = types.ModuleType("faster_whisper")
        fake_module.__path__ = []  # type: ignore[attr-defined]
        fake_module.WhisperModel = whisper_model  # type: ignore[attr-defined]
        fake_utils = types.ModuleType("faster_whisper.utils")

        def download_model(repository: str, **kwargs: object) -> str:
            downloads.append((repository, kwargs))
            output = Path(str(kwargs["output_dir"]))
            for filename, data in payloads[repository].items():
                (output / filename).write_bytes(data)
            metadata = output / ".cache" / "huggingface"
            metadata.mkdir(parents=True)
            (metadata / "transfer.json").write_text("{}", encoding="utf-8")
            return str(output)

        fake_utils.download_model = download_model  # type: ignore[attr-defined]
        return fake_module, fake_utils


if __name__ == "__main__":
    unittest.main()
