import assert from "node:assert/strict";
import test from "node:test";
import { ProviderController } from "../main/provider-controller.js";
import {
  PROVIDER_DISCLOSURE_VERSION,
  PROVIDER_LIMITS
} from "../main/provider-policy.js";

test("Provider Off short-circuits before context, credential, and transport work", async () => {
  let contextCalls = 0;
  const credentialStore = createCredentialStore();
  const transport = createSuccessfulProvider();
  const controller = new ProviderController({
    credentialStore,
    openAIProvider: transport.provider,
    contextBuilder: () => {
      contextCalls += 1;
      return "[]";
    }
  });

  await assert.rejects(controller.requestAssist({}), { code: "provider_off" });
  assert.equal(contextCalls, 0);
  assert.equal(credentialStore.decryptCalls, 0);
  assert.equal(transport.calls, 0);
});

test("consent is exact, per-session, and reset on new session, Off, stop, and revoke", async () => {
  const credentialStore = createCredentialStore();
  const transport = createSuccessfulProvider();
  const controller = new ProviderController({ credentialStore, openAIProvider: transport.provider });
  controller.setMode("openai");
  controller.startSession("meeting-one");

  await assert.rejects(request(controller, "meeting-one"), { code: "consent_required" });
  assert.throws(() => controller.grantConsent({
    sessionId: "meeting-one",
    disclosureVersion: "old-disclosure"
  }), { code: "consent_version_mismatch" });
  grant(controller, "meeting-one");
  await request(controller, "meeting-one");

  controller.startSession("meeting-two");
  await assert.rejects(request(controller, "meeting-two"), { code: "consent_required" });
  grant(controller, "meeting-two");
  controller.setMode("off");
  controller.setMode("openai");
  await assert.rejects(request(controller, "meeting-two"), { code: "consent_required" });

  grant(controller, "meeting-two");
  controller.stopSession();
  controller.startSession("meeting-three");
  await assert.rejects(request(controller, "meeting-three"), { code: "consent_required" });

  grant(controller, "meeting-three");
  const revoked = await controller.revokeCredential();
  assert.deepEqual(revoked, { revoked: true, mode: "off" });
  assert.equal(credentialStore.revokeCalls, 1);
  controller.setMode("openai");
  await assert.rejects(request(controller, "meeting-three"), { code: "consent_required" });
});

test("controller forwards normalized session/revision events without exposing credentials", async () => {
  const credentialStore = createCredentialStore();
  const delivered = [];
  const provider = {
    async streamAssist({ apiKey, onEvent }) {
      assert.equal(apiKey, credentialStore.privateKey);
      await onEvent({ type: "delta", delta: "Use " });
      await onEvent({
        type: "completed",
        text: "Use the Friday example.",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      });
      return {
        text: "Use the Friday example.",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      };
    }
  };
  const controller = new ProviderController({ credentialStore, openAIProvider: provider });
  controller.setMode("openai");
  controller.startSession("meeting-events");
  controller.addFinalSegment({ speaker: "Speaker 1", text: "Friday is better." });
  grant(controller, "meeting-events");

  const result = await controller.requestAssist({
    sessionId: "meeting-events",
    expectedRevision: 1,
    question: "What should I say?",
    onEvent: (event) => delivered.push(event)
  });
  assert.equal(result.text, "Use the Friday example.");
  assert.equal(result.revision, 1);
  assert.equal(JSON.stringify(result).includes(credentialStore.privateKey), false);
  assert.deepEqual(delivered.map(({ type, sessionId, revision }) => ({ type, sessionId, revision })), [
    { type: "delta", sessionId: "meeting-events", revision: 1 },
    { type: "completed", sessionId: "meeting-events", revision: 1 }
  ]);
  const status = await controller.getStatus();
  assert.equal(JSON.stringify(status).includes(credentialStore.privateKey), false);
  assert.equal(status.credentialState, "configured");
  assert.equal(status.removable, true);
  assert.equal(status.inFlight, false);
});

test("controller exposes invalid credential artifacts as removable without raw details", async () => {
  const credentialStore = createCredentialStore();
  credentialStore.getCredentialState = async () => "invalid";
  const controller = new ProviderController({
    credentialStore,
    openAIProvider: createSuccessfulProvider().provider
  });

  const status = await controller.getStatus();
  assert.equal(status.credentialState, "invalid");
  assert.equal(status.configured, false);
  assert.equal(status.removable, true);
  assert.equal(JSON.stringify(status).includes("path"), false);
});

test("controller preserves the sanitized cleanup-required credential result", async () => {
  const credentialStore = createCredentialStore();
  credentialStore.importKey = async () => {
    throw Object.assign(
      new Error("Remove the saved OpenAI API key before importing another key."),
      { code: "credential_cleanup_required" }
    );
  };
  const transport = createSuccessfulProvider();
  const controller = new ProviderController({
    credentialStore,
    openAIProvider: transport.provider
  });

  const error = await controller.importCredential("sk-replacement-test-1234567890")
    .catch((failure) => failure);
  assert.equal(error.code, "credential_cleanup_required");
  assert.equal(error.message, "Remove the saved OpenAI API key before importing another key.");
  assert.equal(credentialStore.decryptCalls, 0);
  assert.equal(transport.calls, 0);
});

test("controller enforces queue zero and supports cancellation without retry", async () => {
  const credentialStore = createCredentialStore();
  let providerCalls = 0;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const provider = {
    streamAssist({ signal }) {
      providerCalls += 1;
      startedResolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("private abort detail"), {
            code: "provider_request_aborted"
          }));
        }, { once: true });
      });
    }
  };
  const controller = readyController({ credentialStore, provider, sessionId: "meeting-busy" });

  const first = request(controller, "meeting-busy");
  await started;
  await assert.rejects(request(controller, "meeting-busy"), { code: "provider_busy" });
  assert.equal(controller.cancelRequest(), true);
  await assert.rejects(first, { code: "provider_request_aborted" });
  assert.equal(providerCalls, 1);
  assert.equal(controller.cancelRequest(), false);
});

test("controller enforces time, rate, and six-request session caps with no retries", async () => {
  let currentTime = 1_000;
  let timeoutCallback;
  const credentialStore = createCredentialStore();
  const hangingProvider = {
    streamAssist({ signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("ignored")), { once: true });
      });
    }
  };
  const timingController = readyController({
    credentialStore,
    provider: hangingProvider,
    sessionId: "meeting-timeout",
    now: () => currentTime,
    setTimeoutFn: (callback, milliseconds) => {
      assert.equal(milliseconds, PROVIDER_LIMITS.requestTimeoutMs);
      timeoutCallback = callback;
      return 1;
    },
    clearTimeoutFn: () => {}
  });
  const timed = request(timingController, "meeting-timeout");
  await new Promise((resolve) => setImmediate(resolve));
  timeoutCallback();
  await assert.rejects(timed, { code: "provider_timeout" });

  const transport = createSuccessfulProvider();
  const capped = readyController({
    credentialStore: createCredentialStore(),
    provider: transport.provider,
    sessionId: "meeting-capped",
    now: () => currentTime
  });
  await request(capped, "meeting-capped");
  await assert.rejects(request(capped, "meeting-capped"), { code: "provider_rate_limit" });
  for (let index = 1; index < PROVIDER_LIMITS.maxRequestsPerSession; index += 1) {
    currentTime += PROVIDER_LIMITS.minRequestIntervalMs;
    await request(capped, "meeting-capped");
  }
  currentTime += PROVIDER_LIMITS.minRequestIntervalMs;
  await assert.rejects(request(capped, "meeting-capped"), { code: "session_request_limit" });
  assert.equal(transport.calls, PROVIDER_LIMITS.maxRequestsPerSession);
});

test("provider failure is sanitized and leaves transcription session context usable", async () => {
  let calls = 0;
  const provider = {
    async streamAssist() {
      calls += 1;
      throw new Error("sk-private transcript private payload");
    }
  };
  const controller = readyController({
    credentialStore: createCredentialStore(),
    provider,
    sessionId: "meeting-failure"
  });
  const error = await request(controller, "meeting-failure").catch((failure) => failure);
  assert.equal(error.code, "provider_failure");
  assert.equal(error.message.includes("private"), false);
  assert.equal(calls, 1);
  assert.deepEqual(controller.addFinalSegment({ speaker: "Speaker 2", text: "Transcription continues." }), {
    revision: 1
  });
  const status = await controller.getStatus();
  assert.equal(status.sessionActive, true);
  assert.equal(status.inFlight, false);
});

function readyController({ credentialStore, provider, sessionId, ...dependencies }) {
  const controller = new ProviderController({
    credentialStore,
    openAIProvider: provider,
    ...dependencies
  });
  controller.setMode("openai");
  controller.startSession(sessionId);
  grant(controller, sessionId);
  return controller;
}

function request(controller, sessionId) {
  return controller.requestAssist({
    sessionId,
    question: "What should I say?"
  });
}

function grant(controller, sessionId) {
  return controller.grantConsent({
    sessionId,
    disclosureVersion: PROVIDER_DISCLOSURE_VERSION
  });
}

function createCredentialStore() {
  return {
    privateKey: "sk-controller-test-1234567890",
    decryptCalls: 0,
    revokeCalls: 0,
    async isEncryptionAvailable() { return true; },
    async getConfigured() { return true; },
    async getCredentialState() { return "configured"; },
    async importKey() { return { configured: true }; },
    async decryptForRequest() {
      this.decryptCalls += 1;
      return this.privateKey;
    },
    async revoke() {
      this.revokeCalls += 1;
      return true;
    }
  };
}

function createSuccessfulProvider() {
  const transport = { calls: 0, provider: null };
  transport.provider = {
    async streamAssist() {
      transport.calls += 1;
      return { text: "Answer", usage: null };
    }
  };
  return transport;
}
