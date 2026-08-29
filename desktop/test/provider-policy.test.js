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
  normalizeProviderContextSnapshot,
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
  assert.match(PROVIDER_DISCLOSURE.summary, /Selecting OpenAI, choosing a meeting profile, editing private context, or importing a key sends nothing\./);
  assert.match(PROVIDER_DISCLOSURE.summary, /question.*shown built-in profile.*private context packs.*finalized transcript text.*anonymous speaker labels and timestamps/i);
  assert.match(PROVIDER_DISCLOSURE.summary, /Audio, draft transcript text, translations, unselected packs, and manual speaker names are never sent\./);
  assert.match(PROVIDER_DISCLOSURE.summary, /API key stays out of the renderer and context pack.*authenticate this OpenAI HTTPS request/i);
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

test("provider accepts only an exact deeply frozen canonical context snapshot", () => {
  const segment = Object.freeze({
    id: "segment-7",
    revision: 3,
    start_ms: 12_000,
    end_ms: 13_500,
    track: "system",
    text: "  Preserve this exact finalized text.  ",
    language: "en",
    speaker_id: "speaker-2"
  });
  const snapshot = Object.freeze({
    sessionId: "meeting-frozen",
    revision: 9,
    transcriptChars: segment.text.length,
    segments: Object.freeze([segment])
  });
  const normalized = normalizeProviderContextSnapshot(snapshot, {
    expectedSessionId: "meeting-frozen"
  });
  assert.deepEqual(normalized, snapshot);
  assert.equal(normalized.segments[0].text, "  Preserve this exact finalized text.  ");
  assert.doesNotMatch(buildTranscriptContext(normalized), /"(?:id|revision|track|speakerId|language)":/);
  assert.match(buildTranscriptContext(normalized), /"startMs":12000/);
  assert.match(buildTranscriptContext(normalized), /"endMs":13500/);
  assert.match(buildTranscriptContext(normalized), /"speakerLabel":"speaker-2"/);
  assert.match(buildTranscriptContext(normalized), /"text":"  Preserve this exact finalized text\.  "/);

  assert.throws(() => normalizeProviderContextSnapshot({ ...snapshot }), { code: "invalid_context" });
  assert.throws(() => normalizeProviderContextSnapshot(Object.freeze({
    ...snapshot,
    segments: [segment]
  })), { code: "invalid_context" });
  assert.throws(() => normalizeProviderContextSnapshot(Object.freeze({
    ...snapshot,
    unexpected: true
  })), { code: "invalid_context" });
  assert.throws(() => normalizeProviderContextSnapshot(snapshot, {
    expectedSessionId: "another-meeting"
  }), { code: "invalid_session" });
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
