import assert from "node:assert/strict";
import test from "node:test";
import { AssistContextBuffer } from "../main/assist-context.js";

function finalEvent(overrides = {}) {
  return {
    type: "final_segment",
    session_id: "session-1",
    segment: {
      id: "segment-1",
      revision: 1,
      start_ms: 1_000,
      end_ms: 2_000,
      track: "system",
      text: "Original meeting text",
      partial: false,
      final: true,
      language: "en",
      speaker_id: "speaker-a",
      ...overrides
    }
  };
}

test("context accepts only non-empty finals from the active backend session", () => {
  const buffer = new AssistContextBuffer();
  buffer.startSession("session-1");

  assert.equal(buffer.ingest({ ...finalEvent(), type: "partial_transcript" }), false);
  assert.equal(buffer.ingest(finalEvent({ final: false, partial: true })), false);
  assert.equal(buffer.ingest(finalEvent({ text: "   " })), false);
  assert.equal(buffer.ingest({ ...finalEvent(), session_id: "old-session" }), false);
  assert.deepEqual(buffer.ingest(finalEvent()), { sessionId: "session-1", revision: 1 });
  assert.equal(buffer.snapshot().segments.length, 1);
});

test("same segment is replaced only by a higher backend revision", () => {
  const buffer = new AssistContextBuffer();
  buffer.startSession("session-1");
  buffer.ingest(finalEvent({ revision: 2, text: "Accepted" }));

  assert.equal(buffer.ingest(finalEvent({ revision: 2, text: "Duplicate" })), false);
  assert.equal(buffer.ingest(finalEvent({ revision: 1, text: "Stale" })), false);
  assert.deepEqual(buffer.ingest(finalEvent({ revision: 3, text: "Corrected" })), {
    sessionId: "session-1",
    revision: 2
  });
  assert.equal(buffer.snapshot().revision, 2);
  assert.equal(buffer.snapshot().segments[0].text, "Corrected");
});

test("snapshot is chronological, deterministic, bounded, cloned, and keeps original text", () => {
  const buffer = new AssistContextBuffer({
    maxFinalSegments: 3,
    maxAgeMs: 15 * 60 * 1_000,
    maxTranscriptChars: 12
  });
  buffer.startSession("session-1");

  const old = finalEvent({ id: "old", start_ms: 0, end_ms: 1_000, text: "old" });
  buffer.ingest(old);
  buffer.ingest(finalEvent({ id: "b", start_ms: 900_000, end_ms: 901_000, text: " B  " }));
  buffer.ingest(finalEvent({ id: "a", start_ms: 900_000, end_ms: 901_000, text: "alpha" }));
  buffer.ingest(finalEvent({ id: "c", start_ms: 902_000, end_ms: 903_000, text: "charlie" }));
  buffer.ingest(finalEvent({ id: "too-big", start_ms: 904_000, end_ms: 905_000, text: "x".repeat(13) }));
  old.segment.text = "mutated outside";

  const snapshot = buffer.snapshot();
  assert.deepEqual(snapshot.segments.map(({ id }) => id), ["b", "c"]);
  assert.equal(snapshot.segments[0].text, " B  ");
  assert.equal(snapshot.segments[1].text, "charlie");
  assert.equal(snapshot.transcriptChars, 11);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.segments), true);
  assert.equal(Object.isFrozen(snapshot.segments[0]), true);
  assert.throws(() => snapshot.segments.push({}), TypeError);
});

test("snapshot retains only 48 recent finals by default", () => {
  const buffer = new AssistContextBuffer();
  buffer.startSession("session-1");
  for (let index = 0; index < 60; index += 1) {
    buffer.ingest(finalEvent({
      id: `segment-${String(index).padStart(2, "0")}`,
      start_ms: index * 1_000,
      end_ms: index * 1_000 + 500,
      text: `line ${index}`
    }));
  }

  const snapshot = buffer.snapshot();
  assert.equal(snapshot.segments.length, 48);
  assert.equal(snapshot.segments[0].id, "segment-12");
  assert.equal(snapshot.segments.at(-1).id, "segment-59");
});

test("new and ended sessions clear all memory without late-stop cross-session damage", () => {
  const buffer = new AssistContextBuffer();
  buffer.startSession("session-1");
  buffer.ingest(finalEvent());
  buffer.startSession("session-2");
  assert.equal(buffer.snapshot().revision, 0);
  assert.deepEqual(buffer.snapshot().segments, []);
  assert.equal(buffer.endSession("session-1"), false);
  assert.equal(buffer.snapshot().sessionId, "session-2");
  assert.equal(buffer.endSession("session-2"), true);
  assert.equal(buffer.snapshot(), null);
});
