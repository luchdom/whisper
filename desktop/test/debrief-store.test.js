import assert from "node:assert/strict";
import test from "node:test";
import {
  DEBRIEF_LIMITS,
  DEBRIEF_SECTION_IDS,
  DebriefStore
} from "../renderer/lib/debrief-store.js";
import { DebriefContextBuffer } from "../main/debrief-context.js";
import { extractLocalDebrief } from "../main/debrief-extractor.js";

const source = Object.freeze({ segment_id: "segment-1", start_ms: 1_000, end_ms: 2_500 });

function emptySections() {
  return {
    summary: { state: "empty", truncated: false, items: [] },
    decisions: { state: "empty", truncated: false, items: [] },
    actions: { state: "empty", truncated: false, items: [] },
    open_questions_risks: { state: "empty", truncated: false, items: [] },
    objections: { state: "empty", truncated: false, items: [] },
    coaching: { state: "not_requested", truncated: false, items: [] }
  };
}

function coverage(overrides = {}) {
  return {
    totalFinalSegments: 1,
    includedFinalSegments: 1,
    omittedFinalSegments: 0,
    totalTranscriptChars: 42,
    includedTranscriptChars: 42,
    truncated: false,
    observedStartMs: 1_000,
    observedEndMs: 2_500,
    includedStartMs: 1_000,
    includedEndMs: 2_500,
    ...overrides
  };
}

function summaryItem(overrides = {}) {
  return {
    id: "local-summary-1",
    text: "We decided to keep the original transcript.",
    sources: [{ ...source }],
    provenance: "local_extractive",
    edited: false,
    ...overrides
  };
}

function readyDocument(overrides = {}) {
  const sections = emptySections();
  sections.summary = { state: "populated", truncated: false, items: [summaryItem()] };
  return {
    schemaVersion: 1,
    state: "ready",
    message: "This local extract covers the retained finalized meeting text.",
    sessionId: "session-1",
    contextRevision: 4,
    complete: true,
    reason: "stopped",
    coverage: coverage(),
    sections,
    ...overrides
  };
}

function resolver(label = "Speaker 1") {
  return (segmentId) => segmentId === "segment-1"
    ? { id: segmentId, start_ms: 1_000, end_ms: 2_500, label }
    : null;
}

test("store accepts only the fixed bounded schema and clones loaded data", () => {
  const store = new DebriefStore();
  const input = readyDocument();
  store.replace(input, { sourceValidator: resolver() });
  input.sections.summary.items[0].text = "Changed outside";
  input.coverage.includedFinalSegments = 99;

  assert.deepEqual(Object.keys(store.snapshot().sections), DEBRIEF_SECTION_IDS);
  assert.equal(store.getItem("summary", "local-summary-1").text, "We decided to keep the original transcript.");
  assert.equal(store.snapshot().coverage.includedFinalSegments, 1);

  const snapshot = store.snapshot();
  snapshot.sections.summary.items[0].sources[0].start_ms = 99;
  assert.equal(store.getItem("summary", "local-summary-1").sources[0].start_ms, 1_000);

  const missing = readyDocument();
  delete missing.sections.decisions;
  assert.throws(() => store.replace(missing), /Missing debrief section: decisions/);
  assert.throws(() => store.replace({ ...readyDocument(), extra: true }), /unsupported field: extra/);
  assert.throws(() => store.replace({
    ...readyDocument(),
    sections: {
      ...readyDocument().sections,
      extra: { state: "empty", truncated: false, items: [] }
    }
  }), /unsupported field: extra/);
});

test("the main-owned local extractor output loads directly into the renderer store", () => {
  const context = new DebriefContextBuffer();
  context.startSession("session-1");
  context.ingest({
    type: "final_segment",
    session_id: "session-1",
    segment: {
      id: "segment-1",
      revision: 1,
      start_ms: 1_000,
      end_ms: 2_500,
      track: "system",
      text: "We decided to keep the integration local.",
      partial: false,
      final: true,
      language: "en",
      speaker_id: "speaker-a",
      translated_text: "Decidimos manter a integração local.",
      translated_language: "pt-BR"
    }
  });
  const draft = extractLocalDebrief(
    context.finalizeSession("session-1", { complete: true, reason: "stopped" }),
    { includeCoaching: false }
  );
  const store = new DebriefStore();

  store.loadDraft(draft, { sourceValidator: resolver() });
  assert.equal(store.snapshot().state, "ready");
  assert.equal(store.getSection("decisions").items[0].text, "We decided to keep the integration local.");
  assert.equal(JSON.stringify(store.snapshot()).includes("Decidimos manter a integração local"), false);
});

test("source validation rejects unknown, mismatched, duplicate, and malformed references", () => {
  const store = new DebriefStore();
  assert.throws(() => store.replace(readyDocument(), { sourceValidator: () => null }), /Unknown debrief source/);
  assert.throws(() => store.replace(readyDocument(), {
    sourceValidator: () => ({ id: "segment-1", start_ms: 9_000, end_ms: 10_000 })
  }), /timestamp mismatch/);

  const duplicate = readyDocument();
  duplicate.sections.summary.items[0].sources.push({ ...source });
  assert.throws(() => store.replace(duplicate), /duplicate source/);

  const reversed = readyDocument();
  reversed.sections.summary.items[0].sources[0] = {
    segment_id: "segment-1",
    start_ms: 3_000,
    end_ms: 2_000
  };
  assert.throws(() => store.replace(reversed), /source end/);
});

test("ready, empty, manual, and partial states cannot contradict completion or truncation", () => {
  const store = new DebriefStore();
  assert.throws(() => store.replace(readyDocument({ sections: emptySections() })), /ready debrief requires/);
  assert.throws(() => store.replace(readyDocument({
    complete: false,
    reason: "capture_interrupted"
  })), /ready debrief requires/);

  const truncatedSections = readyDocument().sections;
  truncatedSections.decisions = { state: "empty", truncated: true, items: [] };
  assert.throws(() => store.replace(readyDocument({ sections: truncatedSections })), /ready debrief requires/);
  assert.throws(() => store.replace(readyDocument({
    state: "manual",
    complete: false,
    reason: "capture_interrupted"
  })), /must remain partial/);
  assert.throws(() => store.replace(readyDocument({
    state: "partial"
  })), /partial debrief requires/);

  store.replace(readyDocument());
  assert.throws(() => store.setState("empty"), /empty debrief cannot retain items/);
  const partial = readyDocument({
    state: "partial",
    complete: false,
    reason: "capture_interrupted"
  });
  store.replace(partial);
  assert.throws(() => store.setState("ready"), /ready debrief requires/);
});

test("coverage validation rejects null-mismatched, reversed, empty, and out-of-bounds ranges", () => {
  const store = new DebriefStore();
  for (const invalidCoverage of [
    coverage({ includedStartMs: null }),
    coverage({ includedStartMs: 3_000, includedEndMs: 2_000 }),
    coverage({
      includedFinalSegments: 0,
      omittedFinalSegments: 1,
      includedTranscriptChars: 0,
      includedStartMs: 1_000,
      includedEndMs: 2_500,
      truncated: true
    }),
    coverage({ includedStartMs: 500 }),
    coverage({ observedEndMs: null })
  ]) {
    assert.throws(() => store.replace(readyDocument({ coverage: invalidCoverage })), /coverage/i);
  }
});

test("generated items remain editable and removable while provenance and source history stay explicit", () => {
  const store = new DebriefStore();
  store.replace(readyDocument());

  const edited = store.updateItem("summary", "local-summary-1", {
    text: "Edited *summary* for the team."
  });
  assert.equal(edited.edited, true);
  assert.equal(edited.provenance, "local_extractive");
  assert.deepEqual(edited.sources, [{ ...source }]);
  assert.equal(store.snapshot().state, "manual");
  assert.equal(store.removeItem("summary", "missing"), false);
  assert.equal(store.removeItem("summary", "local-summary-1"), true);
  assert.equal(store.snapshot().state, "empty");
  assert.equal(store.hasItems(), false);

  const manual = store.addItem("decisions", { text: "Manual decision for review." });
  assert.equal(manual.provenance, "manual");
  assert.equal(manual.edited, true);
  assert.deepEqual(manual.sources, []);
  assert.equal(store.snapshot().state, "manual");
  assert.equal(store.getSection("decisions").state, "populated");
  assert.throws(() => store.updateItem("decisions", manual.id, { owner: { state: "unknown", value: null } }), /only for action items/);
});

test("manual action fields require stated, proposed, or unknown labels and never imply authority", () => {
  const store = new DebriefStore();
  const action = store.addItem("actions", {
    text: "Review whether Alice should own the follow-up.",
    owner: { state: "proposed", value: "Alice" }
  });
  assert.deepEqual(action.owner, { state: "proposed", value: "Alice" });
  assert.deepEqual(action.due, { state: "unknown", value: null });

  const updated = store.updateItem("actions", action.id, {
    due: { state: "stated", value: "Friday" }
  });
  assert.deepEqual(updated.due, { state: "stated", value: "Friday" });
  assert.throws(() => store.updateItem("actions", action.id, {
    owner: { state: "confirmed", value: "Alice" }
  }), /owner state is invalid/);
  assert.throws(() => store.updateItem("actions", action.id, {
    due: { state: "unknown", value: "Friday" }
  }), /must have a null value/);
});

test("Markdown uses resolver-supplied timestamps and current speaker labels without internal IDs", () => {
  const store = new DebriefStore();
  store.replace(readyDocument());
  store.updateItem("summary", "local-summary-1", {
    text: "Edited *summary* [private] <draft>."
  });
  store.addItem("actions", {
    text: "Prepare the follow-up.",
    owner: { state: "proposed", value: "Alice *Lead*" },
    due: { state: "unknown", value: null },
    sources: [{ ...source }]
  });

  const markdown = store.toMarkdown({
    title: "Customer *meeting*",
    sourceResolver: resolver("Alex *Lead*")
  });
  assert.equal(markdown.startsWith("# Customer \\*meeting\\*"), true);
  assert.equal(markdown.includes("Edited \\*summary\\* \\[private\\] \\<draft\\>"), true);
  assert.equal(markdown.includes("Generated sources: [00:01–00:02] Alex \\*Lead\\*"), true);
  assert.equal(markdown.includes("Owner: Proposed — Alice \\*Lead\\*"), true);
  assert.match(markdown, /Due: Not stated/);
  assert.match(markdown, /Provenance: Local extract/);
  assert.doesNotMatch(markdown, /segment-1/);
  assert.doesNotMatch(markdown, /translated_text|Brazilian Portuguese/);

  assert.throws(() => store.toMarkdown(), /source resolver is required/);
  assert.throws(() => store.toMarkdown({
    sourceResolver: () => ({ id: "segment-1", start_ms: 1_001, end_ms: 2_500, label: "Speaker 1" })
  }), /timestamp mismatch/);
});

test("empty, partial, generating, and failed states are explicit and failure preserves prior edits", () => {
  const store = new DebriefStore();
  assert.equal(store.snapshot().state, "empty");
  assert.match(store.toMarkdown(), /Debrief status:\*\* Empty/);
  assert.match(store.toMarkdown(), /No explicit decisions were identified/);
  assert.match(store.toMarkdown(), /## Coaching observations\n\n_Not requested\._/);

  const partial = readyDocument({
    state: "partial",
    message: "This meeting was interrupted.",
    complete: false,
    reason: "capture_interrupted"
  });
  store.replace(partial);
  assert.match(store.toMarkdown({ sourceResolver: resolver() }), /Partial — review coverage/);
  assert.match(store.toMarkdown({ sourceResolver: resolver() }), /meeting was interrupted/);

  store.updateItem("summary", "local-summary-1", { text: "Keep this edit." });
  store.beginGeneration();
  assert.equal(store.snapshot().state, "generating");
  assert.equal(store.getItem("summary", "local-summary-1").text, "Keep this edit.");
  store.markFailed("The local extraction failed safely.");
  assert.equal(store.snapshot().state, "failed");
  assert.equal(store.getItem("summary", "local-summary-1").text, "Keep this edit.");
  assert.match(store.toMarkdown({ sourceResolver: resolver() }), /Generation failed/);
  assert.match(store.toMarkdown({ sourceResolver: resolver() }), /failed safely/);
});

test("coaching request state and store clearing are independent from the bilingual transcript", () => {
  const transcript = {
    segments: [{
      id: "segment-1",
      text: "English original",
      translated_text: "Original em inglês",
      translated_language: "pt-BR"
    }]
  };
  const before = structuredClone(transcript);
  const store = new DebriefStore();
  store.replace(readyDocument());
  assert.equal(store.setCoachingRequested(true), true);
  assert.equal(store.getSection("coaching").state, "empty");
  store.addItem("coaching", { text: "Manual observable note." });
  assert.throws(() => store.setCoachingRequested(false), /Remove coaching items/);

  store.clear();
  assert.equal(store.snapshot().state, "empty");
  assert.equal(store.hasItems(), false);
  assert.deepEqual(transcript, before);
});

test("removing a truncated optional coaching window recomputes a coherent document state", () => {
  const sections = readyDocument().sections;
  sections.coaching = { state: "empty", truncated: true, items: [] };
  const store = new DebriefStore();
  store.replace(readyDocument({
    state: "partial",
    message: "Coaching evidence was bounded.",
    sections
  }));

  assert.equal(store.setCoachingRequested(false), true);
  assert.equal(store.snapshot().state, "ready");
  assert.equal(store.getSection("coaching").state, "not_requested");
  assert.equal(store.getSection("coaching").truncated, false);
  assert.match(store.snapshot().message, /no longer includes a truncated optional coaching/);
});

test("item, source, and section bounds fail closed", () => {
  const store = new DebriefStore();
  assert.throws(() => store.addItem("summary", {
    text: "x".repeat(DEBRIEF_LIMITS.maxItemTextChars + 1)
  }), /no longer than/);
  assert.throws(() => store.addItem("summary", {
    text: "Bounded item",
    sources: Array.from({ length: DEBRIEF_LIMITS.maxSourcesPerItem + 1 }, (_, index) => ({
      segment_id: `segment-${index}`,
      start_ms: index,
      end_ms: index + 1
    }))
  }), /source limit/);

  const oversized = readyDocument();
  oversized.sections.summary = {
    state: "populated",
    truncated: false,
    items: Array.from({ length: DEBRIEF_LIMITS.maxItemsPerSection + 1 }, (_, index) => summaryItem({
      id: `item-${index}`
    }))
  };
  assert.throws(() => store.replace(oversized), /item limit/);
});
