import { EventEmitter } from "node:events";
import {
  DEFAULT_OPENAI_MODEL_ID,
  DEFAULT_PROVIDER_MODE,
  PROVIDER_DISCLOSURE,
  PROVIDER_DISCLOSURE_VERSION,
  PROVIDER_LIMITS,
  assertAvailableProviderMode,
  assertOpenAIModel,
  buildTranscriptContext,
  getProviderCatalog,
  normalizeAssistQuestion,
  normalizeFinalSegment,
  normalizeSessionId
} from "./provider-policy.js";

export class ProviderControllerError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "ProviderControllerError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class ProviderController extends EventEmitter {
  constructor({
    credentialStore,
    openAIProvider,
    now = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    contextBuilder = buildTranscriptContext
  } = {}) {
    super();
    assertCredentialStore(credentialStore);
    if (!openAIProvider || typeof openAIProvider.streamAssist !== "function") {
      throw new TypeError("An OpenAI provider is required.");
    }
    if (typeof now !== "function" || typeof setTimeoutFn !== "function"
      || typeof clearTimeoutFn !== "function" || typeof contextBuilder !== "function") {
      throw new TypeError("Provider controller dependencies are invalid.");
    }

    this.credentialStore = credentialStore;
    this.openAIProvider = openAIProvider;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.contextBuilder = contextBuilder;
    this.mode = DEFAULT_PROVIDER_MODE;
    this.model = DEFAULT_OPENAI_MODEL_ID;
    this.session = null;
    this.inFlight = null;
    this.requestSequence = 0;
  }

  setMode(value) {
    const mode = assertAvailableProviderMode(value);
    if (mode === this.mode) return this.mode;
    this.cancelRequest();
    this.mode = mode;
    if (this.session) this.session.consentVersion = null;
    return this.mode;
  }

  setModel(value) {
    this.model = assertOpenAIModel(value);
    return this.model;
  }

  configure({ mode = this.mode, model = this.model } = {}) {
    const selectedMode = assertAvailableProviderMode(mode);
    const selectedModel = assertOpenAIModel(model);
    this.setMode(selectedMode);
    this.setModel(selectedModel);
    return Object.freeze({ mode: this.mode, model: this.model });
  }

  startSession(value) {
    const id = normalizeSessionId(value);
    this.cancelRequest();
    this.session = {
      id,
      revision: 0,
      segments: [],
      consentVersion: null,
      requestCount: 0,
      lastRequestAt: null
    };
    return Object.freeze({ sessionId: id, revision: 0 });
  }

  stopSession() {
    const existed = this.session !== null;
    this.cancelRequest();
    this.session = null;
    return existed;
  }

  addFinalSegment(value) {
    if (!this.session) return false;
    const segment = normalizeFinalSegment(value);
    if (!segment) return false;
    this.session.segments.push(segment);
    if (this.session.segments.length > PROVIDER_LIMITS.maxStoredSegments) {
      this.session.segments.splice(
        0,
        this.session.segments.length - PROVIDER_LIMITS.maxStoredSegments
      );
    }
    this.session.revision += 1;
    return Object.freeze({ revision: this.session.revision });
  }

  grantConsent({ sessionId, disclosureVersion } = {}) {
    if (this.mode === "off") throw providerOffError();
    const id = normalizeSessionId(sessionId);
    if (!this.session || this.session.id !== id) throw invalidSessionError();
    if (disclosureVersion !== PROVIDER_DISCLOSURE_VERSION) {
      throw new ProviderControllerError(
        "consent_version_mismatch",
        "Review the current data-sharing disclosure before continuing."
      );
    }
    this.session.consentVersion = disclosureVersion;
    return Object.freeze({ granted: true, disclosureVersion });
  }

  revokeConsent() {
    this.cancelRequest();
    if (!this.session) return false;
    const hadConsent = this.session.consentVersion !== null;
    this.session.consentVersion = null;
    return hadConsent;
  }

  async importCredential(value) {
    await this.credentialStore.importKey(value);
    return this.getStatus();
  }

  async revokeCredential() {
    this.cancelRequest();
    this.mode = "off";
    if (this.session) this.session.consentVersion = null;
    const revoked = await this.credentialStore.revoke();
    return Object.freeze({ revoked, mode: this.mode });
  }

  async getStatus() {
    const [credentialState, encryptionAvailable] = await Promise.all([
      this.credentialStore.getCredentialState(),
      this.credentialStore.isEncryptionAvailable()
    ]);
    return Object.freeze({
      mode: this.mode,
      model: this.model,
      credentialState,
      configured: credentialState === "configured",
      removable: credentialState !== "absent",
      encryptionAvailable: encryptionAvailable === true,
      sessionActive: this.session !== null,
      consentGranted: this.session?.consentVersion === PROVIDER_DISCLOSURE_VERSION,
      inFlight: this.inFlight !== null,
      disclosure: PROVIDER_DISCLOSURE,
      catalog: getProviderCatalog()
    });
  }

  async requestAssist({
    sessionId,
    question,
    expectedRevision,
    signal,
    onEvent = () => {}
  } = {}) {
    // This check intentionally precedes session/question/context/credential work.
    // Provider Off therefore has a mechanically testable zero-network boundary.
    if (this.mode === "off") throw providerOffError();
    if (this.mode !== "openai") {
      throw new ProviderControllerError(
        "provider_unavailable",
        "The selected assistance provider is unavailable."
      );
    }
    if (this.inFlight) {
      throw new ProviderControllerError(
        "provider_busy",
        "An assistance request is already in progress."
      );
    }
    if (!this.session || normalizeSessionId(sessionId) !== this.session.id) {
      throw invalidSessionError();
    }
    if (this.session.consentVersion !== PROVIDER_DISCLOSURE_VERSION) {
      throw new ProviderControllerError(
        "consent_required",
        "Approve data sharing for this meeting before requesting assistance."
      );
    }
    if (expectedRevision !== undefined
      && (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.session.revision)) {
      throw new ProviderControllerError(
        "stale_transcript_revision",
        "The transcript changed before the assistance request started."
      );
    }
    if (this.session.requestCount >= PROVIDER_LIMITS.maxRequestsPerSession) {
      throw new ProviderControllerError(
        "session_request_limit",
        "This meeting has reached its assistance request limit."
      );
    }
    const currentTime = this.now();
    if (this.session.lastRequestAt !== null
      && currentTime - this.session.lastRequestAt < PROVIDER_LIMITS.minRequestIntervalMs) {
      throw new ProviderControllerError(
        "provider_rate_limit",
        "Wait a moment before requesting assistance again."
      );
    }
    const normalizedQuestion = normalizeAssistQuestion(question);
    if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function.");

    const operation = {
      requestId: `assist-${++this.requestSequence}`,
      session: this.session,
      revision: this.session.revision,
      abortController: new AbortController(),
      abortReason: null,
      timeout: null,
      removeExternalAbort: null
    };
    this.inFlight = operation;
    operation.timeout = this.setTimeoutFn(() => {
      operation.abortReason = "timeout";
      operation.abortController.abort();
    }, PROVIDER_LIMITS.requestTimeoutMs);
    if (signal) {
      const abortFromCaller = () => {
        operation.abortReason = "canceled";
        operation.abortController.abort();
      };
      if (signal.aborted) abortFromCaller();
      else {
        signal.addEventListener("abort", abortFromCaller, { once: true });
        operation.removeExternalAbort = () => signal.removeEventListener("abort", abortFromCaller);
      }
    }

    try {
      throwIfOperationAborted(operation);
      const context = this.contextBuilder(operation.session.segments);
      if (typeof context !== "string"
        || Buffer.byteLength(context, "utf8") > PROVIDER_LIMITS.maxContextBytes) {
        throw new ProviderControllerError(
          "provider_context_too_large",
          "The meeting context is too large for an assistance request."
        );
      }
      const apiKey = await this.credentialStore.decryptForRequest();
      throwIfOperationAborted(operation);
      if (this.inFlight !== operation || this.session !== operation.session) throw abortedRequestError();

      operation.session.requestCount += 1;
      operation.session.lastRequestAt = this.now();
      const result = await this.openAIProvider.streamAssist({
        apiKey,
        model: this.model,
        question: normalizedQuestion,
        context,
        signal: operation.abortController.signal,
        onEvent: async (event) => {
          if (this.inFlight !== operation || this.session !== operation.session) return;
          const normalized = normalizeProviderEvent(event);
          const envelope = Object.freeze({
            ...normalized,
            requestId: operation.requestId,
            sessionId: operation.session.id,
            revision: operation.revision
          });
          this.emit("event", envelope);
          await onEvent(envelope);
        }
      });
      throwIfOperationAborted(operation);
      if (this.inFlight !== operation || this.session !== operation.session) throw abortedRequestError();
      return Object.freeze({
        requestId: operation.requestId,
        sessionId: operation.session.id,
        revision: operation.revision,
        text: typeof result?.text === "string" ? result.text : "",
        usage: normalizeUsage(result?.usage)
      });
    } catch (error) {
      if (operation.abortReason === "timeout") {
        throw new ProviderControllerError(
          "provider_timeout",
          "The assistance request timed out.",
          { retryable: true }
        );
      }
      if (operation.abortReason === "canceled" || operation.abortController.signal.aborted) {
        throw abortedRequestError();
      }
      throw sanitizeProviderFailure(error);
    } finally {
      this.clearTimeoutFn(operation.timeout);
      operation.removeExternalAbort?.();
      if (this.inFlight === operation) this.inFlight = null;
    }
  }

  cancelRequest() {
    if (!this.inFlight) return false;
    this.inFlight.abortReason = "canceled";
    this.inFlight.abortController.abort();
    return true;
  }
}

function normalizeProviderEvent(value) {
  if (value?.type === "delta" && typeof value.delta === "string") {
    return Object.freeze({ type: "delta", delta: value.delta });
  }
  if (value?.type === "completed" && typeof value.text === "string") {
    return Object.freeze({
      type: "completed",
      text: value.text,
      usage: normalizeUsage(value.usage)
    });
  }
  throw new ProviderControllerError(
    "provider_protocol_error",
    "The assistance provider returned an invalid event."
  );
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.freeze({
    inputTokens: normalizeTokenCount(value.inputTokens),
    outputTokens: normalizeTokenCount(value.outputTokens),
    totalTokens: normalizeTokenCount(value.totalTokens)
  });
}

function normalizeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sanitizeProviderFailure(error) {
  if (error instanceof ProviderControllerError) return error;
  const knownCode = typeof error?.code === "string" && /^[a-z][a-z0-9_]{1,63}$/u.test(error.code)
    ? error.code
    : null;
  const knownMessages = new Map([
    ["credential_missing", "Add an OpenAI API key before requesting assistance."],
    ["secure_storage_unavailable", "Secure credential storage is unavailable on this computer."],
    ["credential_decryption_failed", "The saved OpenAI API key could not be unlocked."],
    ["provider_authentication_failed", "OpenAI rejected the saved API key."],
    ["provider_rate_limited", "OpenAI is rate limiting assistance requests."],
    ["provider_unavailable", "OpenAI is temporarily unavailable."],
    ["provider_network_error", "OpenAI could not be reached."],
    ["provider_request_aborted", "The assistance request was canceled."],
    ["provider_redirect_rejected", "OpenAI returned an unexpected redirect."],
    ["provider_response_too_large", "OpenAI returned more data than this request allows."],
    ["provider_output_too_large", "OpenAI returned more text than this request allows."],
    ["provider_protocol_error", "OpenAI returned an invalid streaming response."],
    ["provider_incomplete_response", "OpenAI ended the response before it was complete."],
    ["provider_request_failed", "OpenAI could not complete the assistance request."],
    ["provider_request_rejected", "OpenAI rejected the assistance request."],
    ["provider_stream_error", "OpenAI returned an unreadable streaming response."]
  ]);
  if (knownCode && knownMessages.has(knownCode)) {
    return new ProviderControllerError(knownCode, knownMessages.get(knownCode), {
      retryable: error?.retryable === true
    });
  }
  return new ProviderControllerError(
    "provider_failure",
    "The assistance request failed without affecting transcription."
  );
}

function throwIfOperationAborted(operation) {
  if (operation.abortController.signal.aborted) throw abortedRequestError();
}

function providerOffError() {
  return new ProviderControllerError(
    "provider_off",
    "Meeting assistance is turned off."
  );
}

function invalidSessionError() {
  return new ProviderControllerError(
    "invalid_session",
    "The assistance request does not belong to the active meeting."
  );
}

function abortedRequestError() {
  return new ProviderControllerError(
    "provider_request_aborted",
    "The assistance request was canceled."
  );
}

function assertCredentialStore(value) {
  for (const method of [
    "isEncryptionAvailable",
    "getConfigured",
    "getCredentialState",
    "importKey",
    "decryptForRequest",
    "revoke"
  ]) {
    if (typeof value?.[method] !== "function") {
      throw new TypeError("A provider credential store is required.");
    }
  }
}
