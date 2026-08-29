import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  ModelCatalogError,
  createModelCatalogFromJson,
  loadModelCatalog,
  parseStrictJson
} from "../main/model-catalog.js";

const manifestUrl = new URL("../../backend/src/meeting_transcriber/model_manifest.json", import.meta.url);
const manifestSource = await fs.readFile(manifestUrl, "utf8");
const manifest = JSON.parse(manifestSource);

test("strict JSON parser rejects duplicate object keys before interpretation", () => {
  assert.throws(
    () => parseStrictJson('{"schema_version":1,"schema_version":1}'),
    (error) => error instanceof ModelCatalogError && error.code === "duplicate_catalog_key"
  );
  assert.throws(
    () => parseStrictJson('{"outer":{"id":"a","id":"b"}}'),
    (error) => error instanceof ModelCatalogError && error.code === "duplicate_catalog_key"
  );
  assert.deepEqual({ ...parseStrictJson('{"safe":[true,false,null,-1.5e2,"ok"]}') }, {
    safe: [true, false, null, -150, "ok"]
  });
});

test("real manifest yields exactly ordered, deeply frozen, redacted renderer DTOs", () => {
  const catalog = createModelCatalogFromJson(manifestSource, { platform: "win32", arch: "x64" });
  const dto = catalog.getRendererDto();

  assert.equal(dto.defaultModelId, "small");
  assert.deepEqual(dto.models.map(({ id }) => id), [
    "tiny", "tiny.en", "base", "base.en", "small", "small.en", "distil-small.en",
    "medium", "medium.en", "distil-medium.en", "distil-large-v3", "distil-large-v3.5",
    "turbo", "large-v3"
  ]);
  assert.deepEqual(dto.models.map(({ tier }) => tier), [
    "very_light", "very_light", "light", "light", "balanced", "balanced", "balanced",
    "high", "high", "high", "high", "high", "high", "very_high"
  ]);
  const sourceSmall = manifest.asr_models.find(({ id }) => id === "small");
  assert.equal(
    dto.models.find(({ id }) => id === "small").downloadBytes,
    sourceSmall.files.reduce((sum, file) => sum + file.size, 0)
  );
  assert.deepEqual(dto.translation, {
    mode: "en_to_pt_br",
    label: "English to Brazilian Portuguese",
    downloadBytes: manifest.translation_models[0].source.size,
    available: true
  });
  assert.equal(Object.isFrozen(dto), true);
  assert.equal(Object.isFrozen(dto.models), true);
  assert.equal(Object.isFrozen(dto.models[0]), true);
  assert.equal(Object.isFrozen(dto.translation), true);

  const serialized = JSON.stringify(dto);
  for (const forbidden of ["repository", "revision", "sha256", "https://", "model.bin", "license", "target_token"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("translation capability is closed to exact manifest platform and architecture", () => {
  const windows = createModelCatalogFromJson(manifestSource, { platform: "win32", arch: "x64" });
  const mac = createModelCatalogFromJson(manifestSource, { platform: "darwin", arch: "arm64" });
  assert.equal(windows.getRendererDto().translation.available, true);
  assert.equal(windows.isTranslationAvailable("en_to_pt_br"), true);
  assert.equal(mac.getRendererDto().translation.available, false);
  assert.equal(mac.isTranslationAvailable("en_to_pt_br"), false);
  assert.equal(mac.isTranslationAvailable("off"), true);
  assert.equal(mac.isTranslationAvailable("cloud"), false);
});

test("closed schema rejects unknown and missing fields anywhere", () => {
  const unknownRoot = cloneManifest();
  unknownRoot.provider = "hidden";
  rejectsManifest(unknownRoot);

  const missingAsr = cloneManifest();
  delete missingAsr.asr_models[0].helper;
  rejectsManifest(missingAsr);

  const unknownNested = cloneManifest();
  unknownNested.translation_models[0].conversion.surprise = true;
  rejectsManifest(unknownNested);
});

test("catalog rejects wrong counts, defaults, ordering, and unsafe identifiers", () => {
  const wrongCount = cloneManifest();
  wrongCount.asr_models.pop();
  rejectsManifest(wrongCount);

  const wrongDefault = cloneManifest();
  wrongDefault.default_asr_model = "base";
  rejectsManifest(wrongDefault);

  const reordered = cloneManifest();
  [reordered.asr_models[0], reordered.asr_models[13]] = [reordered.asr_models[13], reordered.asr_models[0]];
  rejectsManifest(reordered);

  const unsafeId = cloneManifest();
  unsafeId.asr_models[0].id = "../tiny";
  rejectsManifest(unsafeId);
});

test("casefold duplicate IDs, labels, files, and platforms fail closed", () => {
  const duplicateId = cloneManifest();
  duplicateId.asr_models[1].id = duplicateId.asr_models[0].id.toUpperCase();
  rejectsManifest(duplicateId);

  const duplicateLabel = cloneManifest();
  duplicateLabel.asr_models[1].label = duplicateLabel.asr_models[0].label.toUpperCase();
  rejectsManifest(duplicateLabel);

  const duplicateFile = cloneManifest();
  duplicateFile.asr_models[0].files[1].path = duplicateFile.asr_models[0].files[0].path.toUpperCase();
  rejectsManifest(duplicateFile);

  const duplicatePlatform = cloneManifest();
  duplicatePlatform.translation_models[0].platforms.push("WIN32-X64");
  rejectsManifest(duplicatePlatform);
});

test("malformed commits, hashes, sizes, paths, and remote URLs fail closed", () => {
  for (const mutate of [
    (value) => { value.asr_models[0].revision = "main"; },
    (value) => { value.asr_models[0].files[0].sha256 = "A".repeat(64); },
    (value) => { value.asr_models[0].files[0].size = Number.MAX_SAFE_INTEGER; },
    (value) => { value.asr_models[0].files[0].path = "../model.bin"; },
    (value) => { value.speaker_models[0].url = "http://localhost/model"; },
    (value) => { value.speaker_models[0].url = "https://127.0.0.1/model"; },
    (value) => { value.translation_models[0].source.url = "https://user:secret@example.com/model.zip"; },
    (value) => { value.translation_models[0].source.members[0].extract = "yes"; }
  ]) {
    const value = cloneManifest();
    mutate(value);
    rejectsManifest(value);
  }
});

test("translation trust fields mirror the fixed Python manifest contract", () => {
  const mutations = [
    (value) => { value.translation_models[0].platforms = ["darwin-arm64"]; },
    (value) => { value.translation_models[0].platforms = ["win32-x64", "darwin-arm64"]; },
    (value) => {
      value.translation_models[0].source.url =
        "https://example.com/Tatoeba-MT-models/eng-por/model.zip";
    },
    (value) => {
      value.translation_models[0].source.url =
        "https://object.pouta.csc.fi:8443/Tatoeba-MT-models/eng-por/model.zip";
    },
    (value) => {
      value.translation_models[0].source.url =
        "https://object.pouta.csc.fi:443/Tatoeba-MT-models/eng-por/model.zip";
    },
    (value) => {
      value.translation_models[0].source.url =
        "https://object.pouta.csc.fi/Tatoeba-MT-models/eng-por/model.zip?token=private";
    },
    (value) => {
      value.translation_models[0].source.url =
        "https://object.pouta.csc.fi/Tatoeba-MT-models/eng-por/model.zip#private";
    },
    (value) => {
      value.translation_models[0].source.url =
        "https://user:secret@object.pouta.csc.fi/Tatoeba-MT-models/eng-por/model.zip";
    },
    (value) => { value.translation_models[0].source.url = "https://object.pouta.csc.fi"; },
    (value) => { value.translation_models[0].source.members.pop(); },
    (value) => {
      value.translation_models[0].source.members.push(
        structuredClone(value.translation_models[0].source.members[0])
      );
    },
    (value) => {
      for (const member of value.translation_models[0].source.members) member.extract = false;
    },
    (value) => { value.translation_models[0].conversion.version = "4.8.2"; }
  ];

  for (const mutate of mutations) {
    const value = cloneManifest();
    mutate(value);
    rejectsManifest(value);
  }
});

test("missing or unreadable catalog file fails closed without provider details", async () => {
  await assert.rejects(
    loadModelCatalog({
      manifestPath: new URL("missing-manifest.json", manifestUrl).pathname,
      fileSystem: { readFile: async () => { throw new Error("private provider stack"); } }
    }),
    (error) => {
      assert.equal(error instanceof ModelCatalogError, true);
      assert.equal(error.message, "Model catalog unavailable.");
      assert.equal(error.message.includes("provider"), false);
      return true;
    }
  );
});

function cloneManifest() {
  return structuredClone(manifest);
}

function rejectsManifest(value) {
  assert.throws(
    () => createModelCatalogFromJson(JSON.stringify(value), { platform: "win32", arch: "x64" }),
    (error) => error instanceof ModelCatalogError
  );
}
