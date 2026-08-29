import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_SETTINGS,
  createSettingsStore,
  sanitizeSettings
} from "../main/settings-store.js";
import { createModelCatalogFromJson } from "../main/model-catalog.js";

const manifestSource = await fs.readFile(
  new URL("../../backend/src/meeting_transcriber/model_manifest.json", import.meta.url),
  "utf8"
);
const catalog = createModelCatalogFromJson(manifestSource, { platform: "win32", arch: "x64" });
const unavailableCatalog = createModelCatalogFromJson(manifestSource, { platform: "darwin", arch: "arm64" });

test("settings sanitization uses the runtime catalog and preserves multilingual language preference", () => {
  assert.deepEqual(sanitizeSettings(null, { catalog }), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings({
    model: "medium.en",
    language: "pt",
    diarization: false,
    translation: "en_to_pt_br",
    transcriptDirectory: "relative/transcripts",
    autoSave: true,
    providerMode: "openai",
    openAIModel: "gpt-5.6-luna",
    unknown: "discarded"
  }, { catalog }), {
    model: "medium.en",
    language: "pt",
    diarization: false,
    translation: "en_to_pt_br",
    transcriptDirectory: null,
    autoSave: false,
    closeBehavior: "quit",
    minimizeToTray: false,
    providerMode: "openai",
    openAIModel: "gpt-5.6-luna"
  });
  assert.deepEqual(sanitizeSettings({
    model: "removed-model",
    language: "es",
    diarization: "yes",
    translation: "cloud",
    transcriptDirectory: 42,
    autoSave: 1,
    providerMode: "local",
    openAIModel: "renderer-model",
    apiKey: "must-not-persist"
  }, { catalog }), DEFAULT_SETTINGS);

  for (const model of catalog.getRendererDto().models.map(({ id }) => id)) {
    assert.equal(sanitizeSettings({ model, language: "pt" }, { catalog }).language, "pt");
  }
  for (const language of ["auto", "en", "pt"]) {
    assert.equal(sanitizeSettings({ language }, { catalog }).language, language);
  }
  assert.equal(
    sanitizeSettings({ translation: "en_to_pt_br" }, { catalog: unavailableCatalog }).translation,
    "off"
  );
});

test("missing and corrupt settings files load safe defaults", async (t) => {
  const userDataPath = await makeTemporaryDirectory(t);
  const store = createSettingsStore({ userDataPath, catalog });

  assert.deepEqual(await store.load(), DEFAULT_SETTINGS);

  await fs.writeFile(store.filePath, "{ definitely not JSON", "utf8");
  assert.deepEqual(await store.load(), DEFAULT_SETTINGS);

  await fs.writeFile(store.filePath, JSON.stringify({ model: "unknown", autoSave: true }), "utf8");
  assert.deepEqual(await store.load(), DEFAULT_SETTINGS);
});

test("settings save uses the user-data directory, strips unknown values, and leaves no temporary file", async (t) => {
  const root = await makeTemporaryDirectory(t);
  const userDataPath = path.join(root, "nested", "user-data");
  const transcriptDirectory = path.join(root, "transcripts");
  const store = createSettingsStore({ userDataPath, catalog });

  const saved = await store.save({
    model: "base.en",
    language: "auto",
    diarization: false,
    translation: "en_to_pt_br",
    transcriptDirectory,
    autoSave: true,
    closeBehavior: "tray",
    minimizeToTray: true,
    providerMode: "openai",
    openAIModel: "gpt-5.6-luna",
    secret: "not persisted"
  });

  assert.deepEqual(saved, {
    model: "base.en",
    language: "auto",
    diarization: false,
    translation: "en_to_pt_br",
    transcriptDirectory,
    autoSave: true,
    closeBehavior: "tray",
    minimizeToTray: true,
    providerMode: "openai",
    openAIModel: "gpt-5.6-luna"
  });
  assert.deepEqual(await store.load(), saved);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(userDataPath, "settings.json"), "utf8")),
    saved
  );
  assert.deepEqual(await fs.readdir(userDataPath), ["settings.json"]);
});

test("settings update preserves current values while sanitizing the patch", async (t) => {
  const userDataPath = await makeTemporaryDirectory(t);
  const store = createSettingsStore({ userDataPath, catalog });

  await store.save({ ...DEFAULT_SETTINGS, model: "medium", language: "pt", autoSave: true });
  const updated = await store.update({ model: "small.en", autoSave: false, unexpected: true });

  assert.deepEqual(updated, {
    ...DEFAULT_SETTINGS,
    model: "small.en",
    language: "pt",
    autoSave: false
  });
  assert.deepEqual(await store.load(), updated);
});

test("settings store rejects paths outside its injected user-data directory", () => {
  assert.throws(() => createSettingsStore({ userDataPath: "relative", catalog }), /absolute path/);
  assert.throws(
    () => createSettingsStore({ userDataPath: path.resolve("safe"), fileName: "../settings.json", catalog }),
    /plain file name/
  );
  assert.throws(() => createSettingsStore({ userDataPath: path.resolve("safe") }), /validated model catalog/);
});

async function makeTemporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-settings-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
