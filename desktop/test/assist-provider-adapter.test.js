import assert from "node:assert/strict";
import test from "node:test";
import { createAssistProviderAdapter } from "../main/assist-provider-adapter.js";

test("adapter maps callback deltas only to suggestion and applies rendezvous backpressure", async () => {
  let providerFinished = false;
  let captured;
  const providerController = {
    async requestAssist(value) {
      captured = value;
      await value.onEvent({ type: "delta", delta: "First " });
      await value.onEvent({ type: "delta", delta: "second" });
      await value.onEvent({ type: "completed", text: "First second", usage: null });
      providerFinished = true;
      return { text: "First second", usage: null };
    }
  };
  const adapter = createAssistProviderAdapter({ providerController });
  const request = createRequest();
  const iterator = adapter.streamAssist(request, {})[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "delta", channel: "suggestion", delta: "First " }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerFinished, false, "producer waits while the consumer owns the first chunk");
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "delta", channel: "suggestion", delta: "second" }
  });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  assert.equal(providerFinished, true);
  assert.equal(captured.contextSnapshot, request.contextSnapshot);
  assert.equal(captured.question, "What should I say?");
  assert.equal(Object.hasOwn(captured, "objective"), false);
  assert.equal(Object.hasOwn(captured, "ephemeralContext"), false);
});

test("adapter emits a bounded suggestion item only when transport produced no deltas", async () => {
  const adapter = createAssistProviderAdapter({
    providerController: {
      async requestAssist() {
        return { text: "Use the concrete deadline.", usage: null };
      }
    }
  });
  const events = [];
  for await (const event of adapter.streamAssist(createRequest(), {})) events.push(event);
  assert.deepEqual(events, [{
    type: "item",
    channel: "suggestion",
    text: "Use the concrete deadline.",
    citations: []
  }]);
});

test("adapter propagates abort once, closes its rendezvous, and never retries", async () => {
  let calls = 0;
  const providerController = {
    requestAssist({ signal }) {
      calls += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("private abort detail");
          error.code = "provider_request_aborted";
          reject(error);
        }, { once: true });
      });
    }
  };
  const adapter = createAssistProviderAdapter({ providerController });
  const abortController = new AbortController();
  const iterator = adapter.streamAssist(createRequest(), {
    signal: abortController.signal
  })[Symbol.asyncIterator]();
  const pending = iterator.next();
  abortController.abort();

  await assert.rejects(pending, { code: "provider_request_aborted" });
  assert.equal(calls, 1);
});

function createRequest() {
  const segment = Object.freeze({
    id: "segment-1",
    revision: 2,
    start_ms: 1_000,
    end_ms: 2_000,
    track: "system",
    text: "The deadline is Friday.",
    language: "en",
    speaker_id: "speaker-1"
  });
  const contextSnapshot = Object.freeze({
    sessionId: "meeting-1",
    revision: 4,
    transcriptChars: segment.text.length,
    segments: Object.freeze([segment])
  });
  return Object.freeze({
    requestId: "request-1",
    sessionId: "meeting-1",
    contextRevision: 4,
    intent: Object.freeze({ question: "What should I say?" }),
    contextSnapshot,
    policy: Object.freeze({})
  });
}
