import assert from "node:assert/strict";
import test from "node:test";
import { DebriefContextBuffer } from "../main/debrief-context.js";
import {
  DEBRIEF_SECTION_IDS,
  extractLocalDebrief
} from "../main/debrief-extractor.js";

function event(id, text, startMs, overrides = {}) {
  return {
    type: "final_segment",
    session_id: "session-1",
    segment: {
      id,
      revision: 1,
      start_ms: startMs,
      end_ms: startMs + 2_000,
      track: "system",
      text,
      partial: false,
      final: true,
      language: "en",
      speaker_id: "speaker-a",
      translated_text: null,
      translated_language: null,
      ...overrides
    }
  };
}

function completedContext(events, options = {}) {
  const buffer = new DebriefContextBuffer(options);
  buffer.startSession("session-1");
  for (const value of events) buffer.ingest(value);
  return buffer.finalizeSession("session-1", { complete: true, reason: "stopped" });
}

test("local extraction returns every fixed section with exact source IDs and timestamps", () => {
  const context = completedContext([
    event("decision", "We decided to use the verified local model.", 1_000),
    event("action", "Alice will send the report by Friday.", 4_000, { speaker_id: "speaker-b" }),
    event("question", "What remains blocked by procurement?", 7_000),
    event("objection", "I disagree. This will not work because the privacy risk is unresolved.", 10_000),
    event("closing", "The next review starts after the security check.", 13_000)
  ]);

  const result = extractLocalDebrief(context, { includeCoaching: false });
  assert.deepEqual(Object.keys(result.sections), DEBRIEF_SECTION_IDS);
  assert.equal(result.state, "ready");
  assert.equal(result.complete, true);
  assert.equal(result.sections.summary.state, "populated");
  assert.equal(result.sections.decisions.items[0].text, "We decided to use the verified local model.");
  assert.deepEqual(result.sections.decisions.items[0].sources, [{
    segment_id: "decision",
    start_ms: 1_000,
    end_ms: 3_000
  }]);
  assert.equal(result.sections.open_questions_risks.items.some(({ sources }) => (
    sources[0].segment_id === "question"
  )), true);
  assert.equal(result.sections.objections.items.some(({ text }) => text === "I disagree."), true);
  assert.equal(result.sections.coaching.state, "not_requested");
  assert.deepEqual(result.sections.coaching.items, []);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.sections), true);
  assert.equal(Object.isFrozen(result.sections.decisions.items[0].sources), true);
});

test("action extraction rejects obvious negations and labels owner and due certainty conservatively", () => {
  const context = completedContext([
    event("stated", "Alice will send the report by Friday.", 1_000),
    event("proposed", "Action item: Bruno should review the draft by tomorrow.", 4_000),
    event("unknown", "We will review the logs.", 7_000),
    event("negated-en", "I will not email the transcript.", 10_000),
    event("negated-pt", "Não vamos enviar os dados para a nuvem.", 13_000, { language: "pt" }),
    event("positive-pt", "Carla irá revisar o contrato até amanhã.", 16_000, { language: "pt" }),
    event("future-event", "Meeting will start by Friday.", 19_000),
    event("false-owner", "Security could fail by Friday.", 22_000)
  ]);

  const actions = extractLocalDebrief(context, { includeCoaching: false }).sections.actions.items;
  assert.deepEqual(actions.map(({ sources }) => sources[0].segment_id), [
    "stated",
    "proposed",
    "unknown",
    "positive-pt"
  ]);
  assert.deepEqual(actions[0].owner, { state: "stated", value: "Alice" });
  assert.deepEqual(actions[0].due, { state: "stated", value: "Friday" });
  assert.deepEqual(actions[1].owner, { state: "proposed", value: "Bruno" });
  assert.deepEqual(actions[1].due, { state: "proposed", value: "tomorrow" });
  assert.deepEqual(actions[2].owner, { state: "unknown", value: null });
  assert.deepEqual(actions[2].due, { state: "unknown", value: null });
  assert.deepEqual(actions[3].owner, { state: "stated", value: "Carla" });
  assert.deepEqual(actions[3].due, { state: "stated", value: "amanhã" });
});

test("decision extraction supports English and Portuguese without converting undecided text", () => {
  const context = completedContext([
    event("english", "The team agreed to keep transcription local.", 1_000),
    event("portuguese", "Decidimos manter o áudio somente na memória.", 4_000, { language: "pt" }),
    event("label", "Decision: use the verified offline cache.", 5_500),
    event("negative-en", "We have not decided whether to retain audio.", 7_000),
    event("negative-pt", "Não decidimos qual modelo usar.", 10_000, { language: "pt" })
  ]);

  const decisions = extractLocalDebrief(context, { includeCoaching: false }).sections.decisions.items;
  assert.deepEqual(decisions.map(({ sources }) => sources[0].segment_id), ["english", "portuguese", "label"]);
});

test("translation remains preserved in context but is not substituted into local extracted text", () => {
  const context = completedContext([
    event("bilingual", "We decided to keep the English original.", 1_000, {
      translated_text: "Decidimos manter o original em inglês.",
      translated_language: "pt-BR"
    })
  ]);
  const before = structuredClone(context);

  const result = extractLocalDebrief(context, { includeCoaching: false });
  assert.equal(result.sections.decisions.items[0].text, "We decided to keep the English original.");
  assert.equal(JSON.stringify(result).includes("Decidimos manter o original"), false);
  assert.deepEqual(context, before);
  assert.equal(context.segments[0].translated_text, "Decidimos manter o original em inglês.");
});

test("coaching reports only observable talk-time and long finalized-segment signals", () => {
  const context = completedContext([
    event("you-long", "A long presentation segment.", 0, {
      track: "microphone",
      speaker_id: null,
      end_ms: 70_000
    }),
    event("speaker", "A shorter response.", 70_000, {
      speaker_id: "speaker-b",
      end_ms: 100_000
    })
  ]);

  const coaching = extractLocalDebrief(context).sections.coaching.items;
  assert.equal(coaching.length, 2);
  assert.match(coaching[0].text, /microphone track accounts for about 70%/);
  assert.equal(coaching[0].provenance, "local_observation");
  assert.deepEqual(coaching[0].sources, [
    { segment_id: "you-long", start_ms: 0, end_ms: 70_000 },
    { segment_id: "speaker", start_ms: 70_000, end_ms: 100_000 }
  ]);
  assert.match(coaching[1].text, /longest finalized segment lasted about 1m 10s/);
  assert.doesNotMatch(JSON.stringify(coaching), /confidence|tone|sentiment|leadership|persuasive/i);
});

test("question and risk extraction excludes routine check-ins while retaining explicit unresolved prompts", () => {
  const context = completedContext([
    event("check-in", "Can everyone hear me?", 1_000),
    event("answer", "Yes, the audio is clear.", 4_000),
    event("unresolved", "What remains blocked by procurement?", 7_000),
    event("risk", "The deployment risk depends on the security review.", 10_000),
    event("no-risk", "There is no risk in the local path.", 13_000),
    event("resolved", "The blocker is resolved.", 16_000),
    event("not-blocked", "We are not blocked.", 19_000),
    event("active-resolution", "We resolved the blocker.", 22_000),
    event("active-mitigation", "The team mitigated the risk.", 25_000),
    event("active-resolution-pt", "Resolvemos o bloqueio.", 28_000, { language: "pt" })
  ]);

  const items = extractLocalDebrief(context, { includeCoaching: false })
    .sections.open_questions_risks.items;
  assert.deepEqual(items.map(({ sources }) => sources[0].segment_id), ["unresolved", "risk"]);
});

test("extraction limits are visible and force a partial state instead of silent ready output", () => {
  const sentence25 = `${Array.from({ length: 24 }, (_, index) => `Routine note ${index + 1}.`).join(" ")} We decided to ship.`;
  const lateDecision = extractLocalDebrief(
    completedContext([event("sentence-25", sentence25, 1_000)]),
    { includeCoaching: false }
  );
  assert.equal(lateDecision.sections.decisions.items[0].text, "We decided to ship.");
  assert.equal(lateDecision.sections.decisions.truncated, false);

  const manyDecisions = completedContext(Array.from({ length: 13 }, (_, index) => (
    event(`decision-${index}`, `We decided option ${index}.`, index * 3_000)
  )));
  const sectionLimited = extractLocalDebrief(manyDecisions, { includeCoaching: false });
  assert.equal(sectionLimited.sections.decisions.items.length, 12);
  assert.equal(sectionLimited.sections.decisions.truncated, true);
  assert.equal(sectionLimited.state, "partial");
  assert.match(sectionLimited.message, /reached an extraction or source-evidence limit/);
});

test("bounded talk-time coaching cites its complete evidence window and labels the section partial", () => {
  const events = Array.from({ length: 40 }, (_, index) => event(
    `talk-${index}`,
    `Speaking segment ${index}.`,
    index * 1_000,
    {
      end_ms: index * 1_000 + 1_000,
      track: index % 2 === 0 ? "microphone" : "system",
      speaker_id: index % 2 === 0 ? null : "speaker-a"
    }
  ));
  const result = extractLocalDebrief(completedContext(events));
  const coaching = result.sections.coaching;
  assert.equal(coaching.items[0].sources.length, 32);
  assert.match(coaching.items[0].text, /Within the most recent 32 source-linked/);
  assert.equal(coaching.truncated, true);
  assert.equal(result.state, "partial");
});

test("active, truncated, interrupted, empty, and failed meetings produce honest states", () => {
  const activeBuffer = new DebriefContextBuffer();
  activeBuffer.startSession("session-1");
  activeBuffer.ingest(event("active", "We decided to continue.", 1_000));
  const active = extractLocalDebrief(activeBuffer.snapshot(), { includeCoaching: false });
  assert.equal(active.state, "partial");
  assert.match(active.message, /meeting has not stopped/);

  const bounded = completedContext([
    event("old", "We decided the old option.", 0),
    event("latest", "We decided the latest option.", 4_000)
  ], { maxFinalSegments: 1, maxTranscriptChars: 100 });
  const truncated = extractLocalDebrief(bounded, { includeCoaching: false });
  assert.equal(truncated.state, "partial");
  assert.equal(truncated.coverage.truncated, true);
  assert.match(truncated.message, /only the retained finalized-text window/);

  const interruptedBuffer = new DebriefContextBuffer();
  interruptedBuffer.startSession("session-1");
  interruptedBuffer.ingest(event("partial", "We will preserve completed segments.", 1_000));
  const interrupted = extractLocalDebrief(
    interruptedBuffer.finalizeSession("session-1", {
      complete: false,
      reason: "capture_interrupted"
    }),
    { includeCoaching: false }
  );
  assert.equal(interrupted.state, "partial");
  assert.match(interrupted.message, /incomplete meeting \(capture_interrupted\)/);

  const emptyContext = completedContext([]);
  const empty = extractLocalDebrief(emptyContext, { includeCoaching: false });
  assert.equal(empty.state, "empty");
  assert.equal(DEBRIEF_SECTION_IDS.every((id) => empty.sections[id].items.length === 0), true);

  const failedBuffer = new DebriefContextBuffer();
  failedBuffer.startSession("session-1");
  const failed = extractLocalDebrief(
    failedBuffer.finalizeSession("session-1", { complete: false, reason: "backend_failed" }),
    { includeCoaching: false }
  );
  assert.equal(failed.state, "failed");
  assert.match(failed.message, /No finalized text/);
});

test("extractor fails closed on malformed context and unsupported options", () => {
  const context = completedContext([event("one", "We decided to proceed.", 1_000)]);
  assert.throws(() => extractLocalDebrief({ ...context, complete: false }), /completion state is inconsistent/);
  assert.throws(() => extractLocalDebrief({
    ...context,
    coverage: { ...context.coverage, includedFinalSegments: 2 }
  }), /included-segment count is inconsistent/);
  assert.throws(() => extractLocalDebrief(context, { includeCoaching: "yes" }), /must be a boolean/);
});
