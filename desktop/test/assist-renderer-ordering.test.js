import assert from "node:assert/strict";
import test from "node:test";
import { AssistController } from "../main/assist-controller.js";
import { createFakeAssistProvider } from "../main/fake-assist-provider.js";
import {
  AssistRequestAttempt,
  AssistRequestGate
} from "../renderer/lib/assist-request-gate.js";

test("renderer waits for the accepted terminal event when the request reply wins the delivery race", async () => {
  const controller = new AssistController({
    provider: createFakeAssistProvider({ delayMs: 0 }),
    createRequestId: () => "request-runtime-ordering"
  });
  controller.startSession("session-runtime-ordering");
  controller.ingest({
    type: "final_segment",
    session_id: "session-runtime-ordering",
    segment: {
      id: "segment-runtime-ordering",
      revision: 1,
      start_ms: 0,
      end_ms: 1_000,
      track: "system",
      text: "The team agreed to ship the review build tomorrow.",
      language: "en",
      speaker_id: "Speaker 1",
      final: true,
      partial: false
    }
  });

  const context = controller.freezeContextForRequest();
  const gate = new AssistRequestGate();
  gate.activateSession(context.sessionId, context.revision);
  gate.beginRequest(context.revision);

  const attempt = new AssistRequestAttempt({ deliveryTimeoutMs: 1_000 });
  assert.equal(attempt.bindContext(context.sessionId, context.revision), true);
  assert.equal(attempt.markDispatched(), true);

  const queuedEvents = [];
  controller.on("event", (event) => {
    queuedEvents.push(event);
    if (event.type !== "assist_completed") return;

    setImmediate(() => {
      for (const queuedEvent of queuedEvents) {
        assert.equal(gate.accepts(queuedEvent), true);
        if (queuedEvent.type === "assist_started") {
          assert.equal(attempt.bindStarted(queuedEvent), true);
        } else if (["assist_completed", "assist_error", "assist_canceled"].includes(queuedEvent.type)) {
          assert.equal(attempt.acceptTerminal(queuedEvent), true);
        }
      }
    });
  });

  const reply = await controller.request({ question: "What should I say next?" });

  assert.equal(reply.status, "completed");
  assert.equal(attempt.terminalEvent, null);
  assert.deepEqual(
    queuedEvents.map(({ type }) => type),
    ["assist_started", "assist_delta", "assist_delta", "assist_completed"]
  );

  const terminal = await attempt.waitForTerminal();
  assert.equal(terminal.type, "assist_completed");
  assert.equal(terminal.requestId, "request-runtime-ordering");
  assert.equal(terminal.sessionId, context.sessionId);
  assert.equal(terminal.contextRevision, context.revision);
  assert.equal(attempt.terminalEvent, terminal);
  assert.equal(gate.activeRequest.terminal, true);
  attempt.finish();
});
