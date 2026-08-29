import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createBackendStartOptions,
  validateRendererSettingsPatch
} from "../main/desktop-policy.js";
import { createModelCatalogFromJson } from "../main/model-catalog.js";

const userDataPath = path.resolve("test-user-data");
const manifestSource = await fs.readFile(
  new URL("../../backend/src/meeting_transcriber/model_manifest.json", import.meta.url),
  "utf8"
);
const catalog = createModelCatalogFromJson(manifestSource, { platform: "win32", arch: "x64" });
const unavailableCatalog = createModelCatalogFromJson(manifestSource, { platform: "darwin", arch: "arm64" });

test("backend start policy preserves allowlisted selections and owns runtime paths", () => {
  assert.deepEqual(createBackendStartOptions({
    model: "medium",
    language: "pt",
    diarization: true,
    translation: "en_to_pt_br"
  }, { userDataPath, catalog }), {
    model: "medium",
    language: "pt",
    device: "cpu",
    compute: "int8",
    download_root: path.join(userDataPath, "models", "asr"),
    diarization: "online",
    diarization_model: path.join(userDataPath, "models", catalog.getSpeakerFileName()),
    translation: "en_to_pt_br",
    translation_model: path.join(userDataPath, "models", "translation")
  });
});

test("English-only models force English while speaker detection can be disabled", () => {
  const options = createBackendStartOptions({
    model: "small.en",
    language: "auto",
    diarization: false,
    translation: "off"
  }, { userDataPath, catalog });

  assert.equal(options.language, "en");
  assert.equal(options.diarization, "off");
  assert.equal(options.translation, "off");
  assert.equal(options.translation_model, null);
  assert.equal(options.diarization_model.startsWith(userDataPath), true);
});

test("renderer cannot select arbitrary engines, runtime options, or model paths", () => {
  assert.throws(
    () => createBackendStartOptions({ model: "../large-v3", language: "auto", diarization: true, translation: "off" }, { userDataPath, catalog }),
    /model is not supported/
  );
  assert.throws(
    () => createBackendStartOptions({ model: "small", language: "auto", diarization: true, translation: "off", device: "cuda" }, { userDataPath, catalog }),
    /unsupported field/
  );
  assert.throws(
    () => createBackendStartOptions({ model: "small", language: "auto", diarization: true, translation: "off", diarization_model: "C:\\other.onnx" }, { userDataPath, catalog }),
    /unsupported field/
  );
  assert.throws(
    () => createBackendStartOptions({ model: "small", language: "auto", diarization: true, translation: "en_to_pt_br" }, { userDataPath, catalog: unavailableCatalog }),
    /unavailable in this build/
  );
});

test("settings IPC policy accepts only renderer-editable scalar fields", () => {
  assert.deepEqual(validateRendererSettingsPatch({
    model: "base.en",
    language: "en",
    diarization: false,
    translation: "en_to_pt_br",
    autoSave: true
  }, { catalog }), {
    model: "base.en",
    language: "en",
    diarization: false,
    translation: "en_to_pt_br",
    autoSave: true
  });

  assert.throws(
    () => validateRendererSettingsPatch({ transcriptDirectory: "C:\\private" }, { catalog }),
    /unsupported field/
  );
  assert.throws(
    () => validateRendererSettingsPatch({ path: "C:\\private\\meeting.md" }, { catalog }),
    /unsupported field/
  );
  assert.throws(
    () => validateRendererSettingsPatch({ translation: "en_to_pt_br" }, { catalog: unavailableCatalog }),
    /unavailable in this build/
  );
});
