import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OPENAI_MODEL_ID,
  DEFAULT_PROVIDER_MODE,
  OPENAI_MODEL_IDS,
  PROVIDER_LIMITS,
  PROVIDER_DISCLOSURE,
  assertAvailableProviderMode,
  assertOpenAIModel,
  buildTranscriptContext,
  getProviderCatalog,
  normalizeAssistQuestion,
  resolveProviderExternalLink,
  sanitizeStoredProviderSettings
} from "../main/provider-policy.js";

test("provider policy defaults to Off and represents the future local mode as unavailable", () => {
  const catalog = getProviderCatalog();
  assert.equal(DEFAULT_PROVIDER_MODE, "off");
  assert.equal(catalog.defaultMode, "off");
  assert.deepEqual(catalog.modes.map(({ id, available }) => [id, available]), [
    ["off", true],
    ["openai", true],
    ["local", false]
  ]);
  assert.throws(() => assertAvailableProviderMode("local"), { code: "provider_unavailable" });
  assert.throws(() => assertAvailableProviderMode("custom"), { code: "invalid_provider_mode" });
});

test("provider disclosure and external navigation use fixed main-owned values", () => {
  assert.match(PROVIDER_DISCLOSURE.summary, /Selecting OpenAI or importing a key sends nothing\./);
  assert.match(PROVIDER_DISCLOSURE.summary, /Audio, drafts, and unconfirmed text are never sent\./);
  assert.deepEqual(PROVIDER_DISCLOSURE.links.map(({ id }) => id), [
    "privacy",
    "data-controls",
    "usage"
  ]);
  assert.equal(
    resolveProviderExternalLink("data-controls"),
    "https://developers.openai.com/api/docs/guides/your-data"
  );
  assert.throws(() => resolveProviderExternalLink("https://attacker.example"), {
    code: "invalid_provider_link"
  });
});

test("provider policy accepts only the immutable current OpenAI model allowlist", () => {
  assert.deepEqual(OPENAI_MODEL_IDS, ["gpt-5.6-luna"]);
  assert.equal(assertOpenAIModel(DEFAULT_OPENAI_MODEL_ID), "gpt-5.6-luna");
  assert.throws(() => assertOpenAIModel("gpt-4o"), { code: "invalid_provider_model" });
  assert.deepEqual(sanitizeStoredProviderSettings({
    providerMode: "openai",
    openAIModel: "renderer-controlled"
  }), {
    providerMode: "openai",
    openAIModel: "gpt-5.6-luna"
  });
  assert.deepEqual(sanitizeStoredProviderSettings({ providerMode: "local" }), {
    providerMode: "off",
    openAIModel: "gpt-5.6-luna"
  });
});

test("questions and finalized transcript context are UTF-8 bounded", () => {
  assert.equal(normalizeAssistQuestion("  What did Alex promise?  "), "What did Alex promise?");
  assert.throws(
    () => normalizeAssistQuestion("x".repeat(PROVIDER_LIMITS.maxQuestionBytes + 1)),
    { code: "question_too_large" }
  );

  const segments = Array.from({ length: 100 }, (_, index) => ({
    speaker: `Speaker ${index % 3 + 1}`,
    text: `${index}: ${"meeting context ".repeat(100)}`,
    startMs: index * 1_000,
    endMs: index * 1_000 + 500
  }));
  const context = buildTranscriptContext(segments);
  const parsed = JSON.parse(context);
  assert.equal(Buffer.byteLength(context, "utf8") <= PROVIDER_LIMITS.maxContextBytes, true);
  assert.equal(parsed.at(-1).text.startsWith("99:"), true);
  assert.equal(parsed[0].text.startsWith("0:"), false, "oldest segments are dropped first");
});
