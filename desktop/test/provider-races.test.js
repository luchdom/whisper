import assert from "node:assert/strict";
import test from "node:test";
import { AssistController } from "../main/assist-controller.js";
import { ProviderController } from "../main/provider-controller.js";
import {
  PROVIDER_DISCLOSURE_VERSION,
  PROVIDER_LIMITS
} from "../main/provider-policy.js";

test("only dispatch-qualified Sends consume the session attempt budget", async () => {
  let currentTime = 10_000;
  let providerCalls = 0;
  const credentialStore = createCredentialStore();
  const controller = readyProviderController({
    credentialStore,
    sessionId: "meeting-accounting",
    now: () => currentTime,
    provider: {
      async streamAssist() {
        providerCalls += 1;
        return { text: "Answer", usage: null };
      }
    }
  });

  await assert.rejects(providerRequest(controller, "wrong-meeting"), { code: "invalid_session" });
  assert.equal(controller.session.requestCount, 0);
  assert.equal(credentialStore.decryptCalls, 0);

  controller.revokeConsent();
  await assert.rejects(providerRequest(controller, "meeting-accounting"), { code: "consent_required" });
  assert.equal(controller.session.requestCount, 0);
  grant(controller, "meeting-accounting");

  await assert.rejects(controller.requestAssist({
    sessionId: "meeting-accounting",
    contextSnapshot: createProviderSnapshot("stale-meeting"),
    question: "What should I say?"
  }), { code: "invalid_session" });
  assert.equal(controller.session.requestCount, 0);

  const alreadyCanceled = new AbortController();
  alreadyCanceled.abort();
  await assert.rejects(controller.requestAssist({
    sessionId: "meeting-accounting",
    contextSnapshot: createProviderSnapshot("meeting-accounting"),
    question: "What should I say?",
    signal: alreadyCanceled.signal
  }), { code: "provider_request_aborted" });
  assert.equal(controller.session.requestCount, 1, "a dispatched-but-canceled Send is one attempt");
  assert.equal(credentialStore.decryptCalls, 0);
  assert.equal(providerCalls, 0);

  currentTime += PROVIDER_LIMITS.minRequestIntervalMs;
  await providerRequest(controller, "meeting-accounting");
  assert.equal(controller.session.requestCount, 2);
  assert.equal(credentialStore.decryptCalls, 1);
  assert.equal(providerCalls, 1);

  await assert.rejects(providerRequest(controller, "meeting-accounting"), {
    code: "provider_rate_limit"
  });
  assert.equal(controller.session.requestCount, 2, "pre-dispatch rate rejection consumes no attempt");
  assert.equal(providerCalls, 1, "no request path retries the provider");
});

test("consent revocation cancels a decrypting request, suppresses late events, and preserves context", async () => {
  let currentTime = 10_000;
  const decrypt = deferred();
  const started = deferred();
  const providerResult = deferred();
  const delivered = [];
  const snapshot = createProviderSnapshot("meeting-consent");
  const before = structuredClone(snapshot);
  let providerCalls = 0;
  let providerSignal;
  let emitProviderEvent;
  const credentialStore = createCredentialStore({ decryptPromise: decrypt.promise });
  const controller = readyProviderController({
    credentialStore,
    sessionId: "meeting-consent",
    now: () => currentTime,
    provider: {
      streamAssist({ signal, onEvent }) {
        providerCalls += 1;
        providerSignal = signal;
        emitProviderEvent = onEvent;
        started.resolve();
        return providerResult.promise;
      }
    }
  });

  const pending = controller.requestAssist({
    sessionId: "meeting-consent",
    contextSnapshot: snapshot,
    question: "What should I say?",
    onEvent: (event) => delivered.push(event)
  });
  assert.equal(controller.session.requestCount, 1);
  assert.equal(controller.revokeConsent(), true);
  assert.equal(controller.session.consentVersion, null);

  decrypt.resolve("sk-race-test-1234567890");
  await assert.rejects(pending, { code: "provider_request_aborted" });
  assert.equal(providerCalls, 0, "revocation during credential decrypt reaches no transport");
  assert.equal(delivered.length, 0);
  assert.deepEqual(snapshot, before);

  // Repeat at the transport boundary to prove a provider that ignores Abort
  // cannot publish a late event or success after consent is revoked.
  currentTime += PROVIDER_LIMITS.minRequestIntervalMs;
  grant(controller, "meeting-consent");
  const second = controller.requestAssist({
    sessionId: "meeting-consent",
    contextSnapshot: snapshot,
    question: "What should I say?",
    onEvent: (event) => delivered.push(event)
  });
  await started.promise;
  assert.equal(controller.revokeConsent(), true);
  assert.equal(providerSignal.aborted, true);
  await emitProviderEvent({ type: "delta", delta: "LATE_PROVIDER_CANARY" });
  providerResult.resolve({ text: "LATE_PROVIDER_CANARY", usage: null });
  await assert.rejects(second, { code: "provider_request_aborted" });

  const status = await controller.getStatus();
  assert.equal(status.consentGranted, false);
  assert.equal(status.inFlight, false);
  assert.deepEqual(delivered, []);
  assert.equal(providerCalls, 1);
  assert.deepEqual(snapshot, before, "cancel/revoke must not mutate the transcript snapshot");
});

test("concurrent Send and cancel have one owner, one terminal, and no hidden queue", async () => {
  const started = deferred();
  const release = deferred();
  let providerCalls = 0;
  let firstSignal;
  let requestSequence = 0;
  const provider = {
    async streamAssist(_request, { signal }) {
      providerCalls += 1;
      if (providerCalls === 1) {
        firstSignal = signal;
        started.resolve();
        await release.promise;
        return emptyStream();
      }
      return itemStream("Second request succeeds.");
    }
  };
  const controller = new AssistController({
    provider,
    createRequestId: () => `request-${++requestSequence}`
  });
  const events = collect(controller);
  controller.startSession("meeting-concurrent");
  controller.ingest(finalEvent({ sessionId: "meeting-concurrent" }));
  const transcriptBefore = structuredClone(controller.getContextSnapshot());
  controller.freezeContextForRequest();

  const first = controller.request({ question: "First Send" });
  await started.promise;
  await assert.rejects(controller.request({ question: "Concurrent Send" }), {
    code: "assist_busy"
  });
  assert.equal(providerCalls, 1);

  const canceled = controller.cancel("canceled");
  assert.equal(canceled.type, "assist_canceled");
  assert.equal(firstSignal.aborted, true);
  await assert.rejects(controller.request({ question: "Send while cancel unwinds" }), {
    code: "assist_busy"
  });
  release.resolve();
  assert.deepEqual(await first, {
    status: "canceled",
    requestId: "request-1",
    reason: "canceled"
  });

  assert.equal(events.filter((event) => (
    event.requestId === "request-1"
      && ["assist_completed", "assist_error", "assist_canceled"].includes(event.type)
  )).length, 1);
  controller.freezeContextForRequest();
  const second = await controller.request({ question: "Second Send" });
  assert.equal(second.status, "completed");
  assert.equal(providerCalls, 2, "there is no queued or retried provider request");
  assert.deepEqual(controller.getContextSnapshot(), transcriptBefore);
});

test("context advancement stays frozen while stop/restart suppresses every late old-meeting event", async () => {
  const firstStarted = deferred();
  const firstRelease = deferred();
  const staleStarted = deferred();
  const staleRelease = deferred();
  let providerCalls = 0;
  let requestSequence = 0;
  const provider = {
    async streamAssist(_request, { signal }) {
      providerCalls += 1;
      if (providerCalls === 1) {
        firstStarted.resolve(signal);
        await firstRelease.promise;
        return itemStream("Answer from frozen revision.");
      }
      if (providerCalls === 2) {
        staleStarted.resolve(signal);
        await staleRelease.promise;
        return itemStream("LATE_OLD_MEETING_CANARY");
      }
      return itemStream("Answer for the restarted meeting.", "segment-b");
    }
  };
  const controller = new AssistController({
    provider,
    createRequestId: () => `revision-request-${++requestSequence}`
  });
  const events = collect(controller);
  controller.startSession("meeting-a");
  controller.ingest(finalEvent({ sessionId: "meeting-a", text: "Initial fact.", revision: 1 }));
  controller.freezeContextForRequest();
  const revisionOne = controller.request({ question: "Use the frozen context" });
  await firstStarted.promise;

  controller.ingest(finalEvent({
    sessionId: "meeting-a",
    text: "Corrected fact.",
    revision: 2
  }));
  assert.equal(controller.getContextSnapshot().revision, 2);
  firstRelease.resolve();
  assert.equal((await revisionOne).status, "completed");
  const firstEvents = events.filter(({ requestId }) => requestId === "revision-request-1");
  assert.equal(firstEvents.every(({ contextRevision }) => contextRevision === 1), true);
  assert.equal(controller.getContextSnapshot().segments[0].text, "Corrected fact.");

  controller.freezeContextForRequest();
  const stale = controller.request({ question: "This meeting will stop" });
  const staleSignal = await staleStarted.promise;
  assert.equal(controller.endSession("meeting-a"), true);
  assert.equal(staleSignal.aborted, true);
  controller.startSession("meeting-b");
  controller.ingest(finalEvent({
    sessionId: "meeting-b",
    id: "segment-b",
    text: "New meeting fact.",
    revision: 1
  }));
  staleRelease.resolve();
  assert.deepEqual(await stale, {
    status: "canceled",
    requestId: "revision-request-2",
    reason: "session_reset"
  });
  assert.equal(events.some((event) => (
    event.requestId === "revision-request-2"
      && event.type === "assist_item"
      && event.text === "LATE_OLD_MEETING_CANARY"
  )), false);

  controller.freezeContextForRequest();
  const restarted = await controller.request({ question: "Use meeting B only" });
  assert.equal(restarted.status, "completed");
  const restartedItems = events.filter((event) => (
    event.requestId === "revision-request-3" && event.type === "assist_item"
  ));
  assert.deepEqual(restartedItems.map(({ text, sessionId, contextRevision }) => ({
    text,
    sessionId,
    contextRevision
  })), [{
    text: "Answer for the restarted meeting.",
    sessionId: "meeting-b",
    contextRevision: 1
  }]);
  assert.equal(providerCalls, 3);
  assert.equal(controller.getContextSnapshot().segments[0].text, "New meeting fact.");
});

function readyProviderController({ credentialStore, provider, sessionId, now = () => 10_000 }) {
  const controller = new ProviderController({
    credentialStore,
    openAIProvider: provider,
    now
  });
  controller.setMode("openai");
  controller.startSession(sessionId);
  grant(controller, sessionId);
  return controller;
}

function providerRequest(controller, sessionId, overrides = {}) {
  return controller.requestAssist({
    sessionId,
    contextSnapshot: createProviderSnapshot(sessionId),
    question: "What should I say?",
    ...overrides
  });
}

function createProviderSnapshot(sessionId) {
  const segment = Object.freeze({
    id: "segment-1",
    revision: 1,
    start_ms: 1_000,
    end_ms: 2_000,
    track: "system",
    text: "The deadline is Tuesday.",
    language: "en",
    speaker_id: "speaker-1"
  });
  return Object.freeze({
    sessionId,
    revision: 1,
    transcriptChars: segment.text.length,
    segments: Object.freeze([segment])
  });
}

function finalEvent({
  sessionId,
  id = "segment-1",
  text = "The deadline is Tuesday.",
  revision = 1
}) {
  return {
    type: "final_segment",
    session_id: sessionId,
    segment: {
      id,
      revision,
      start_ms: 1_000,
      end_ms: 2_000,
      track: "system",
      text,
      partial: false,
      final: true,
      language: "en",
      speaker_id: "speaker-1"
    }
  };
}

function createCredentialStore({ decryptPromise = null } = {}) {
  return {
    decryptCalls: 0,
    async isEncryptionAvailable() { return true; },
    async getConfigured() { return true; },
    async getCredentialState() { return "configured"; },
    async importKey() { return { configured: true }; },
    async decryptForRequest() {
      this.decryptCalls += 1;
      if (decryptPromise) return decryptPromise;
      return "sk-race-test-1234567890";
    },
    async revoke() { return true; }
  };
}

function grant(controller, sessionId) {
  return controller.grantConsent({
    sessionId,
    disclosureVersion: PROVIDER_DISCLOSURE_VERSION
  });
}

function collect(controller) {
  const events = [];
  controller.on("event", (event) => events.push(event));
  return events;
}

function itemStream(text, citation = "segment-1") {
  return (async function* stream() {
    yield {
      type: "item",
      channel: "suggestion",
      text,
      citations: [citation]
    };
  }());
}

function emptyStream() {
  return (async function* stream() {})();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
