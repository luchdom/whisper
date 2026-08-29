import assert from "node:assert/strict";
import test from "node:test";
import { DebriefContextBuffer } from "../main/debrief-context.js";

function finalEvent(overrides = {}, eventOverrides = {}) {
  return {
    type: "final_segment",
    session_id: "session-1",
    segment: {
      id: "segment-1",
      revision: 1,
      start_ms: 1_000,
      end_ms: 2_000,
      track: "system",
      text: "We decided to ship the local draft.",
      partial: false,
      final: true,
      language: "en",
      speaker_id: "speaker-a",
      translated_text: "Decidimos enviar o rascunho local.",
      translated_language: "pt-BR",
      ...overrides
    },
    ...eventOverrides
  };
}

test("debrief context ingests only non-empty finals from the active session", () => {
  const buffer = new DebriefContextBuffer();
  assert.equal(buffer.ingest(finalEvent()), false);
  buffer.startSession("session-1");

  assert.equal(buffer.ingest({ ...finalEvent(), type: "partial_transcript" }), false);
  assert.equal(buffer.ingest(finalEvent({ final: false, partial: true })), false);
  assert.equal(buffer.ingest(finalEvent({ text: "   " })), false);
  assert.equal(buffer.ingest(finalEvent({}, { session_id: "session-old" })), false);
  assert.deepEqual(buffer.ingest(finalEvent()), {
    sessionId: "session-1",
    revision: 1,
    state: "active"
  });
  assert.equal(buffer.snapshot().segments.length, 1);

  buffer.finalizeSession("session-1", { complete: true, reason: "stopped" });
  assert.equal(buffer.ingest(finalEvent({ id: "late", revision: 2 })), false);
});

test("higher revisions replace in place and preserve original plus translation metadata", () => {
  const buffer = new DebriefContextBuffer();
  buffer.startSession("session-1");
  const event = finalEvent({ revision: 2 });
  buffer.ingest(event);

  assert.equal(buffer.ingest(finalEvent({ revision: 2, text: "Duplicate" })), false);
  assert.equal(buffer.ingest(finalEvent({ revision: 1, text: "Stale" })), false);
  assert.deepEqual(buffer.ingest(finalEvent({
    revision: 3,
    text: "Alice will send the report by Friday.",
    language: "en",
    translated_text: "Alice enviará o relatório até sexta-feira.",
    translated_language: "pt-BR"
  })), {
    sessionId: "session-1",
    revision: 2,
    state: "active"
  });
  event.segment.text = "Changed outside";
  event.segment.translated_text = "Mudou fora";

  const snapshot = buffer.snapshot();
  assert.equal(snapshot.revision, 2);
  assert.deepEqual(snapshot.segments[0], {
    id: "segment-1",
    revision: 3,
    start_ms: 1_000,
    end_ms: 2_000,
    track: "system",
    text: "Alice will send the report by Friday.",
    language: "en",
    speaker_id: "speaker-a",
    translated_text: "Alice enviará o relatório até sexta-feira.",
    translated_language: "pt-BR"
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.coverage), true);
  assert.equal(Object.isFrozen(snapshot.segments), true);
  assert.equal(Object.isFrozen(snapshot.segments[0]), true);
});

test("invalid or orphaned translation metadata is rejected without losing original context", () => {
  const buffer = new DebriefContextBuffer();
  buffer.startSession("session-1");
  assert.equal(buffer.ingest(finalEvent({
    translated_text: null,
    translated_language: "pt-BR"
  })), false);
  assert.equal(buffer.ingest(finalEvent({
    translated_text: "Texto",
    translated_language: "pt"
  })), false);
  assert.equal(buffer.ingest(finalEvent({ track: "unknown" })), false);

  assert.notEqual(buffer.ingest(finalEvent({
    translated_text: null,
    translated_language: null
  })), false);
  assert.equal(buffer.snapshot().segments[0].translated_text, null);
  assert.equal(buffer.snapshot().segments[0].text, "We decided to ship the local draft.");
});

test("successful stop retains a complete source-linked snapshot until explicit clear", () => {
  const buffer = new DebriefContextBuffer();
  buffer.startSession("session-1");
  buffer.ingest(finalEvent());

  const finalized = buffer.finalizeSession("session-1", {
    complete: true,
    reason: "stopped"
  });
  assert.equal(finalized.state, "complete");
  assert.equal(finalized.complete, true);
  assert.equal(finalized.reason, "stopped");
  assert.equal(finalized.coverage.totalFinalSegments, 1);
  assert.deepEqual(buffer.snapshot(), finalized);
  assert.equal(buffer.finalizeSession("session-1", { complete: false, reason: "late" }), false);

  buffer.clear();
  assert.equal(buffer.snapshot(), null);
});

test("failed and interrupted stops retain honest incomplete states and coverage", () => {
  const buffer = new DebriefContextBuffer();
  buffer.startSession("session-1");
  buffer.ingest(finalEvent({ translated_text: null, translated_language: null }));

  assert.equal(buffer.finalizeSession("wrong-session", {
    complete: false,
    reason: "capture_interrupted"
  }), false);
  const snapshot = buffer.finalizeSession("session-1", {
    complete: false,
    reason: "capture_interrupted"
  });
  assert.equal(snapshot.state, "incomplete");
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.reason, "capture_interrupted");
  assert.equal(snapshot.coverage.includedFinalSegments, 1);
  assert.equal(snapshot.coverage.truncated, false);

  const empty = new DebriefContextBuffer();
  empty.startSession("empty-session");
  const failed = empty.finalizeSession("empty-session", { complete: false, reason: "backend_failed" });
  assert.equal(failed.state, "incomplete");
  assert.deepEqual(failed.coverage, {
    totalFinalSegments: 0,
    includedFinalSegments: 0,
    omittedFinalSegments: 0,
    totalTranscriptChars: 0,
    includedTranscriptChars: 0,
    truncated: false,
    observedStartMs: null,
    observedEndMs: null,
    includedStartMs: null,
    includedEndMs: null
  });
});

test("bounded snapshots keep one deterministic recent contiguous window and report omissions", () => {
  const buffer = new DebriefContextBuffer({ maxFinalSegments: 2, maxTranscriptChars: 10 });
  buffer.startSession("session-1");
  buffer.ingest(finalEvent({
    id: "old",
    start_ms: 0,
    end_ms: 1_000,
    text: "aaaa",
    translated_text: null,
    translated_language: null
  }));
  buffer.ingest(finalEvent({
    id: "middle",
    start_ms: 2_000,
    end_ms: 3_000,
    text: "bbbbbb",
    translated_text: null,
    translated_language: null
  }));
  buffer.ingest(finalEvent({
    id: "latest",
    start_ms: 4_000,
    end_ms: 5_000,
    text: "ccccc",
    translated_text: null,
    translated_language: null
  }));

  const snapshot = buffer.finalizeSession("session-1", { complete: true, reason: "stopped" });
  assert.deepEqual(snapshot.segments.map(({ id }) => id), ["latest"]);
  assert.deepEqual(snapshot.coverage, {
    totalFinalSegments: 3,
    includedFinalSegments: 1,
    omittedFinalSegments: 2,
    totalTranscriptChars: 15,
    includedTranscriptChars: 5,
    truncated: true,
    observedStartMs: 0,
    observedEndMs: 5_000,
    includedStartMs: 4_000,
    includedEndMs: 5_000
  });
  assert.equal(buffer.segments.size, 1);
  assert.equal(buffer.omittedRevisions.size <= buffer.limits.maxFinalSegments, true);
});

test("evicted source text stays bounded while recent omitted revisions remain replaceable", () => {
  const buffer = new DebriefContextBuffer({ maxFinalSegments: 2, maxTranscriptChars: 100 });
  buffer.startSession("session-1");
  for (let index = 0; index < 5; index += 1) {
    buffer.ingest(finalEvent({
      id: `segment-${index}`,
      revision: 1,
      start_ms: index * 1_000,
      end_ms: index * 1_000 + 500,
      text: `line-${index}`,
      translated_text: null,
      translated_language: null
    }));
  }

  assert.equal(buffer.segments.size, 2);
  assert.equal(buffer.omittedRevisions.size, 2);
  assert.deepEqual(buffer.snapshot().segments.map(({ id }) => id), ["segment-3", "segment-4"]);
  assert.equal(buffer.snapshot().coverage.totalFinalSegments, 5);
  assert.equal(buffer.snapshot().coverage.omittedFinalSegments, 3);

  assert.notEqual(buffer.ingest(finalEvent({
    id: "segment-2",
    revision: 2,
    start_ms: 2_000,
    end_ms: 2_500,
    text: "corrected-line-2",
    translated_text: null,
    translated_language: null
  })), false);
  assert.equal(buffer.segments.size, 2);
  assert.equal(buffer.snapshot().coverage.totalFinalSegments, 5);

  assert.equal(buffer.ingest(finalEvent({
    id: "segment-0",
    revision: 2,
    start_ms: 0,
    end_ms: 500,
    text: "forgotten-correction",
    translated_text: null,
    translated_language: null
  })), false);
  assert.equal(buffer.snapshot().coverage.totalFinalSegments, 5);
  assert.equal(buffer.snapshot().coverage.totalTranscriptChars, 40);
});

test("a successful new session clears the retained meeting without late-stop damage", () => {
  const buffer = new DebriefContextBuffer();
  buffer.startSession("session-1");
  buffer.ingest(finalEvent());
  buffer.finalizeSession("session-1", { complete: true, reason: "stopped" });

  buffer.startSession("session-2");
  assert.equal(buffer.snapshot().sessionId, "session-2");
  assert.equal(buffer.snapshot().state, "active");
  assert.deepEqual(buffer.snapshot().segments, []);
  assert.equal(buffer.finalizeSession("session-1", { complete: false, reason: "late" }), false);
  assert.equal(buffer.snapshot().sessionId, "session-2");
  assert.throws(() => buffer.startSession("   "), /session ID is invalid/);
});
