import assert from "node:assert/strict";
import test from "node:test";
import { createAssistEvent } from "../main/assist-protocol.js";
import {
  AssistRequestAttempt,
  AssistRequestCanceledError,
  AssistRequestGate,
  AssistRequestSupersededError,
  AssistStatusGenerationGate,
  AssistTerminalDeliveryTimeoutError
} from "../renderer/lib/assist-request-gate.js";

function event(type, sequence, overrides = {}) {
  const payloads = {
    assist_started: { type },
    assist_delta: { type, channel: "suggestion", delta: "Say this" },
    assist_item: { type, channel: "suggestion", text: "Say this", citations: [] },
    assist_completed: {
      type,
      metrics: { timeToFirstTokenMs: 10, totalMs: 20, outputChars: 8 }
    },
    assist_error: {
      type,
      error: { code: "provider_failure", message: "Assistance failed.", retryable: false }
    },
    assist_canceled: { type, reason: "canceled" }
  };
  return createAssistEvent({
    requestId: "request-1",
    sessionId: "session-1",
    contextRevision: 3,
    sequence,
    ...overrides
  }, payloads[type]);
}

test("gate accepts one exact sequence and rejects duplicates, gaps, and post-terminal events", () => {
  const gate = new AssistRequestGate();
  gate.activateSession("session-1", 3);
  gate.beginRequest();

  assert.equal(gate.accepts(event("assist_started", 1)), true);
  assert.equal(gate.accepts(event("assist_started", 1)), false);
  assert.equal(gate.accepts(event("assist_delta", 3)), false);
  assert.equal(gate.accepts(event("assist_delta", 2)), true);
  assert.equal(gate.accepts(event("assist_delta", 2)), false);
  assert.equal(gate.accepts(event("assist_completed", 3)), true);
  assert.equal(gate.accepts(event("assist_item", 4)), false);
});

test("transcript advancement after start does not invalidate the frozen context revision", () => {
  const gate = new AssistRequestGate();
  gate.activateSession("session-1", 3);
  gate.beginRequest();
  gate.advanceTranscript(5);
  assert.equal(gate.accepts(event("assist_started", 1)), true);
  assert.equal(gate.advanceTranscript(9), true);
  assert.equal(gate.accepts(event("assist_delta", 2)), true);
  assert.equal(gate.accepts(event("assist_completed", 3)), true);
});

test("an exact main-owned preflight revision is accepted while stale identities still fail closed", () => {
  const gate = new AssistRequestGate();
  gate.activateSession("session-1", 2);
  gate.advanceTranscript(3);
  gate.beginRequest();
  assert.equal(gate.accepts(event("assist_started", 1)), true);
  assert.equal(gate.transcriptRevision, 3);
  assert.equal(gate.accepts(event("assist_delta", 2, { sessionId: "old-session" })), false);
  assert.equal(gate.accepts(event("assist_delta", 2, { requestId: "old-request" })), false);
  assert.equal(gate.accepts(event("assist_delta", 2, { contextRevision: 2 })), false);
  assert.equal(gate.accepts(event("assist_delta", 2)), true);
});

test("an exact frozen revision remains valid after newer transcript text arrives", () => {
  const gate = new AssistRequestGate();
  gate.activateSession("session-1", 5);
  gate.beginRequest(3);
  assert.equal(gate.accepts(event("assist_started", 1)), true);
  assert.equal(gate.transcriptRevision, 5);
});

test("started events that do not match the exact frozen revision are rejected", () => {
  const gate = new AssistRequestGate();
  gate.activateSession("session-1", 4);
  gate.beginRequest();
  assert.equal(gate.accepts(event("assist_started", 1)), false);

  gate.activateSession("session-1", 2);
  gate.beginRequest();
  assert.equal(gate.accepts(event("assist_started", 1)), false);
});

test("a new started event supersedes the old request and a restarted session rejects late output", () => {
  const gate = new AssistRequestGate();
  gate.activateSession("session-1", 3);
  gate.beginRequest();
  assert.equal(gate.accepts(event("assist_started", 1)), true);
  gate.beginRequest();
  assert.equal(gate.accepts(event("assist_delta", 2)), false);
  assert.equal(gate.accepts(event("assist_started", 1, { requestId: "request-2" })), true);
  assert.equal(gate.accepts(event("assist_delta", 2)), false);
  assert.equal(gate.accepts(event("assist_delta", 2, { requestId: "request-2" })), true);

  gate.activateSession("session-2", 0);
  assert.equal(gate.accepts(event("assist_completed", 3, { requestId: "request-2" })), false);
  assert.equal(gate.endSession("session-1"), false);
  assert.equal(gate.endSession("session-2"), true);
});

test("malformed or closed-schema-violating events never enter renderer state", () => {
  const gate = new AssistRequestGate();
  gate.activateSession("session-1", 3);
  gate.beginRequest();
  assert.equal(gate.accepts({ ...event("assist_started", 1), model: "attacker-model" }), false);
  assert.equal(gate.accepts(null), false);
});

test("request attempt latches a strictly identified terminal event before the invoke reply is observed", async () => {
  const attempt = new AssistRequestAttempt({ deliveryTimeoutMs: 50 });
  const started = event("assist_started", 1);
  const completed = event("assist_completed", 2);

  assert.equal(attempt.bindContext("session-1", 3), true);
  assert.equal(attempt.markDispatched(), true);
  assert.equal(attempt.bindStarted(started), true);
  assert.equal(attempt.acceptTerminal(completed), true);
  assert.deepEqual(await attempt.waitForTerminal(), completed);
  attempt.finish();
});

test("request attempt waits across renderer turns and rejects a terminal event from another identity", async () => {
  const attempt = new AssistRequestAttempt({ deliveryTimeoutMs: 100 });
  const started = event("assist_started", 1);
  const completed = event("assist_completed", 2);

  attempt.bindContext("session-1", 3);
  attempt.markDispatched();
  attempt.bindStarted(started);
  const terminal = attempt.waitForTerminal();
  assert.equal(attempt.acceptTerminal({ ...completed, requestId: "other-request" }), false);
  setImmediate(() => attempt.acceptTerminal(completed));
  assert.deepEqual(await terminal, completed);
  attempt.finish();
});

test("request attempt cancellation closes every preflight window but does not impersonate provider cancellation", () => {
  const beforeContext = new AssistRequestAttempt();
  assert.equal(beforeContext.cancel(), true);
  assert.throws(
    () => beforeContext.throwIfCanceledBeforeDispatch(),
    AssistRequestCanceledError
  );

  const afterContext = new AssistRequestAttempt();
  afterContext.bindContext("session-1", 3);
  assert.equal(afterContext.cancel(), true);
  assert.throws(() => afterContext.markDispatched(), AssistRequestCanceledError);

  const afterDispatch = new AssistRequestAttempt();
  afterDispatch.bindContext("session-1", 3);
  afterDispatch.markDispatched();
  assert.equal(afterDispatch.cancel(), false);
  assert.doesNotThrow(() => afterDispatch.throwIfCanceledBeforeDispatch());
});

test("request attempt times out without accepting a later terminal event", async () => {
  const attempt = new AssistRequestAttempt({ deliveryTimeoutMs: 10 });
  const completed = event("assist_completed", 2);
  attempt.bindContext("session-1", 3);
  attempt.markDispatched();
  attempt.bindStarted(event("assist_started", 1));

  await assert.rejects(
    attempt.waitForTerminal(),
    AssistTerminalDeliveryTimeoutError
  );
  assert.equal(attempt.waiters.size, 0);
  assert.equal(attempt.closed, true);
  assert.equal(attempt.acceptTerminal(completed), false);
  assert.equal(attempt.terminalEvent, null);
  attempt.finish();
});

test("status generation drops a delayed response from meeting A after meeting B starts", async () => {
  const gate = new AssistStatusGenerationGate();
  const applied = [];
  let releaseMeetingA;
  const meetingAResponse = new Promise((resolve) => { releaseMeetingA = resolve; });

  gate.transition("session-a");
  const meetingAIdentity = gate.capture();
  const delayedMeetingA = meetingAResponse.then((response) => {
    if (gate.accepts(meetingAIdentity, response.sessionId)) applied.push(response.sessionId);
  });

  gate.transition("session-b");
  const meetingBIdentity = gate.capture();
  releaseMeetingA({ sessionId: "session-a" });
  await delayedMeetingA;
  if (gate.accepts(meetingBIdentity, "session-b")) applied.push("session-b");

  assert.deepEqual(applied, ["session-b"]);
});

test("status generation guarantees a fresh same-session response after a finalized revision", async () => {
  const gate = new AssistStatusGenerationGate();
  gate.transition("session-b");
  const revisionZeroIdentity = gate.capture();

  const revisionOneIdentity = gate.invalidate();
  assert.equal(gate.accepts(revisionZeroIdentity, "session-b"), false);
  assert.equal(gate.accepts(revisionOneIdentity, "session-b"), true);
  assert.equal(gate.accepts(revisionOneIdentity, "session-a"), false);
});

test("meeting transition supersedes a waiting attempt and rejects its delayed canceled event", async () => {
  const attempt = new AssistRequestAttempt({ deliveryTimeoutMs: 100 });
  attempt.bindContext("session-a", 3);
  attempt.markDispatched();
  attempt.bindStarted(event("assist_started", 1, { sessionId: "session-a" }));
  const waiting = attempt.waitForTerminal();

  assert.equal(attempt.supersede(), true);
  await assert.rejects(waiting, AssistRequestSupersededError);
  assert.equal(
    attempt.acceptTerminal(event("assist_canceled", 2, { sessionId: "session-a" })),
    false
  );
  assert.equal(attempt.terminalEvent, null);
});

test("meeting identity survives same-session final invalidation but not stop and restart", () => {
  const gate = new AssistStatusGenerationGate();
  const meetingA = gate.transition("session-a");
  gate.invalidate();
  assert.equal(gate.isSameSession(meetingA), true);
  assert.equal(gate.isCurrent(meetingA), false);

  gate.transition(null);
  gate.transition("session-b");
  assert.equal(gate.isSameSession(meetingA), false);
});
