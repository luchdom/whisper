import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createModelCatalogFromJson } from "../main/model-catalog.js";
import {
  formatDownloadBytes,
  getEffectiveLanguage,
  groupCatalogModels,
  sanitizeCatalogDto
} from "../renderer/lib/model-presentation.js";

const manifestUrl = new URL("../../backend/src/meeting_transcriber/model_manifest.json", import.meta.url);

test("renderer presentation preserves all 14 manifest models and native tier group order", async () => {
  const source = await readFile(manifestUrl, "utf8");
  const trusted = createModelCatalogFromJson(source, { platform: "win32", arch: "x64" }).getRendererDto();
  const catalog = sanitizeCatalogDto(structuredClone(trusted));

  assert.ok(catalog);
  assert.equal(Object.isFrozen(catalog), true);
  assert.deepEqual(catalog.models.map(({ id }) => id), [
    "tiny", "tiny.en", "base", "base.en", "small", "small.en", "distil-small.en",
    "medium", "medium.en", "distil-medium.en", "distil-large-v3", "distil-large-v3.5",
    "turbo", "large-v3"
  ]);
  assert.deepEqual(groupCatalogModels(catalog).map(({ label, models }) => [label, models.length]), [
    ["Very light", 2],
    ["Light", 2],
    ["Balanced", 3],
    ["High", 6],
    ["Very high", 1]
  ]);
  assert.equal(catalog.translation.available, true);
});

test("renderer catalog DTO validation fails closed and language locking is metadata-driven", async () => {
  const source = await readFile(manifestUrl, "utf8");
  const dto = structuredClone(createModelCatalogFromJson(source).getRendererDto());
  dto.models[0].repository = "private/provider";
  assert.equal(sanitizeCatalogDto(dto), null);

  assert.equal(getEffectiveLanguage({ languageMode: "english_only" }, "pt"), "en");
  assert.equal(getEffectiveLanguage({ languageMode: "multilingual" }, "pt"), "pt");
  assert.equal(formatDownloadBytes(486_400_000), "486 MB");
  assert.equal(formatDownloadBytes(1_530_000_000), "1.53 GB");
});
