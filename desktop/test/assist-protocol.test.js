import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSIST_LIMITS,
  createAssistEvent,
  normalizeProviderAssistEvent,
  normalizeRendererAssistRequest,
  sanitizeAssistError,
  validateAssistEvent
} from "../main/assist-protocol.js";

test("renderer intent is closed, bounded, trimmed, and contains no provider controls", () => {
  assert.deepEqual(normalizeRendererAssistRequest({
    question: "  How should I answer?  "
  }), {
    question: "How should I answer?"
  });

  for (const forbidden of [
    "endpoint", "model", "prompt", "credential", "apiKey", "tools",
    "objective", "ephemeralContext", "sessionId", "contextRevision"
  ]) {
    assert.throws(
      () => normalizeRendererAssistRequest({ question: "Help", [forbidden]: "attacker-controlled" }),
      /unexpected field/
    );
  }
  assert.throws(
    () => normalizeRendererAssistRequest({ question: "x".repeat(ASSIST_LIMITS.maxQuestionChars + 1) }),
    /too long/
  );
});

test("provider channels and citations are allowlisted against the frozen snapshot", () => {
  assert.deepEqual(normalizeProviderAssistEvent({
    type: "delta",
    channel: "suggestion",
    delta: " "
  }, []), {
    type: "assist_delta",
    channel: "suggestion",
    delta: " "
  });
  assert.deepEqual(normalizeProviderAssistEvent({
    type: "item",
    channel: "supporting_point",
    text: "The rollout date was Tuesday.",
    citations: ["segment-2", "segment-2"]
  }, new Set(["segment-1", "segment-2"])), {
    type: "assist_item",
    channel: "supporting_point",
    text: "The rollout date was Tuesday.",
    citations: ["segment-2"]
  });
  assert.throws(() => normalizeProviderAssistEvent({
    type: "item",
    channel: "answer",
    text: "Unsupported",
    citations: []
  }, []), /invalid channel/);
  assert.throws(() => normalizeProviderAssistEvent({
    type: "item",
    channel: "suggestion",
    text: "Unsupported citation",
    citations: ["not-in-context"]
  }, ["segment-1"]), /unknown transcript context/);
  assert.throws(() => normalizeProviderAssistEvent({
    type: "delta",
    channel: "suggestion",
    delta: "Do this",
    action: { type: "send_email" }
  }, []), /unexpected field/);
});

test("outbound envelopes are closed and enforce an exact monotonic sequence", () => {
  const event = createAssistEvent({
    requestId: "request-1",
    sessionId: "session-1",
    contextRevision: 4,
    sequence: 2
  }, {
    type: "assist_delta",
    channel: "caveat",
    delta: "This is an inference."
  });

  assert.deepEqual(validateAssistEvent(event, { expectedSequence: 2 }), event);
  assert.throws(() => validateAssistEvent(event, { expectedSequence: 3 }), /out of order/);
  assert.throws(() => validateAssistEvent({ ...event, endpoint: "https://evil.invalid" }), /unexpected field/);
  assert.throws(() => validateAssistEvent({ ...event, sequence: 0 }), /sequence is invalid/);
});

test("provider failures are sanitized without forwarding secrets or raw messages", () => {
  const known = sanitizeAssistError({
    code: "provider_authentication_failed",
    message: "sk-secret was rejected by https://api.example.invalid"
  });
  assert.equal(known.code, "provider_authentication_failed");
  assert.doesNotMatch(JSON.stringify(known), /sk-secret|api\.example/);

  const unknown = sanitizeAssistError(new Error("prompt=secret credential=secret"));
  assert.deepEqual(unknown, {
    code: "provider_failure",
    message: "Assistance failed without affecting transcription.",
    retryable: false
  });
});
