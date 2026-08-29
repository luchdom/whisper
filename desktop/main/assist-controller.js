import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { AssistContextBuffer } from "./assist-context.js";
import {
  ASSIST_LIMITS,
  AssistProtocolError,
  createAssistEvent,
  normalizeProviderAssistEvent,
  normalizeRendererAssistRequest,
  sanitizeAssistError
} from "./assist-protocol.js";
import { normalizeAssistSessionContext } from "./provider-policy.js";

export const ASSIST_PROVIDER_POLICY = Object.freeze({
  transcriptIsUntrustedInput: true,
  contextPacksAreUntrustedInput: true,
  profileIsAppOwnedPreference: true,
  toolsAllowed: false,
  externalActionsAllowed: false,
  retries: 0,
  queueDepth: 0
});

export class AssistController extends EventEmitter {
  constructor({
    provider,
    contextBuffer = new AssistContextBuffer(),
    now = Date.now,
    createRequestId = () => `assist-${randomUUID()}`,
    maxOutputChars = ASSIST_LIMITS.maxOutputChars
  } = {}) {
    super();
    if (!provider || typeof provider.streamAssist !== "function") {
      throw new TypeError("An assistance provider with streamAssist is required.");
    }
    if (!(contextBuffer instanceof AssistContextBuffer)) {
      throw new TypeError("An AssistContextBuffer is required.");
    }
    if (typeof now !== "function" || typeof createRequestId !== "function") {
      throw new TypeError("Assistance controller dependencies are invalid.");
    }
    if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars <= 0) {
      throw new TypeError("maxOutputChars must be a positive integer.");
    }

    this.provider = provider;
    this.contextBuffer = contextBuffer;
    this.now = now;
    this.createRequestId = createRequestId;
    this.maxOutputChars = maxOutputChars;
    this.inFlight = null;
    this.frozenContextForRequest = null;
    this.sessionContext = null;
  }

  startSession(sessionId, sessionContext = null) {
    this.cancel("session_reset");
    this.frozenContextForRequest = null;
    this.sessionContext = sessionContext === null
      ? null
      : normalizeAssistSessionContext(sessionContext);
    return this.contextBuffer.startSession(sessionId);
  }

  endSession(sessionId = this.contextBuffer.sessionId) {
    const activeSessionId = this.contextBuffer.sessionId;
    if (activeSessionId === null || sessionId !== activeSessionId) return false;
    this.cancel("session_reset");
    this.frozenContextForRequest = null;
    this.sessionContext = null;
    return this.contextBuffer.endSession(sessionId);
  }

  ingest(value) {
    return this.contextBuffer.ingest(value);
  }

  getContextSnapshot() {
    return this.contextBuffer.snapshot();
  }

  getRequestContextSnapshot() {
    const snapshot = this.contextBuffer.snapshot();
    return snapshot && this.sessionContext
      ? Object.freeze({
          ...snapshot,
          profile: this.sessionContext.profile,
          contextPacks: this.sessionContext.contextPacks
        })
      : snapshot;
  }

  freezeContextForRequest() {
    this.frozenContextForRequest = this.getRequestContextSnapshot();
    return this.frozenContextForRequest;
  }

  getSessionContextSummary() {
    if (!this.sessionContext) return null;
    return Object.freeze({
      profile: Object.freeze({
        id: this.sessionContext.profile.id,
        version: this.sessionContext.profile.version,
        name: this.sessionContext.profile.name
      }),
      contextPacks: Object.freeze(this.sessionContext.contextPacks.map((pack) => Object.freeze({
        kind: pack.kind,
        name: pack.name,
        bytes: Buffer.byteLength(pack.content, "utf8")
      })))
    });
  }

  async request(value) {
    const intent = normalizeRendererAssistRequest(value);
    if (this.inFlight) {
      throw new AssistControllerError(
        "assist_busy",
        "Wait for the current assistance request to finish canceling."
      );
    }
    const context = this.frozenContextForRequest;
    if (!context || context.sessionId !== this.contextBuffer.sessionId) {
      throw new AssistControllerError(
        "assist_context_not_frozen",
        "Freeze the finalized context before requesting assistance."
      );
    }
    if (context.segments.length === 0) {
      throw new AssistControllerError(
        "assist_context_empty",
        "Wait for finalized transcript text before requesting assistance."
      );
    }
    this.frozenContextForRequest = null;

    const requestId = normalizeRequestId(this.createRequestId());
    const operation = {
      requestId,
      sessionId: context.sessionId,
      contextRevision: context.revision,
      context,
      validSegmentIds: new Set(context.segments.map((segment) => segment.id)),
      sequence: 0,
      startedAt: normalizeClock(this.now()),
      firstTokenAt: null,
      outputChars: 0,
      abortController: new AbortController(),
      terminal: false,
      cancelReason: null
    };
    this.inFlight = operation;
    this.#emit(operation, { type: "assist_started" });

    const providerRequest = Object.freeze({
      requestId,
      sessionId: context.sessionId,
      contextRevision: context.revision,
      intent,
      contextSnapshot: context,
      policy: ASSIST_PROVIDER_POLICY
    });

    try {
      const stream = await this.provider.streamAssist(providerRequest, {
        signal: operation.abortController.signal
      });
      if (!isIterable(stream)) {
        throw providerProtocolError();
      }

      for await (const rawEvent of stream) {
        if (!this.#isCurrent(operation)) break;
        let event;
        try {
          event = normalizeProviderAssistEvent(rawEvent, operation.validSegmentIds);
        } catch (error) {
          if (error instanceof AssistProtocolError) throw providerProtocolError();
          throw error;
        }

        const payloadChars = event.type === "assist_delta" ? event.delta.length : event.text.length;
        if (operation.outputChars + payloadChars > this.maxOutputChars) {
          throw providerOutputTooLargeError();
        }
        operation.outputChars += payloadChars;
        if (operation.firstTokenAt === null) operation.firstTokenAt = normalizeClock(this.now());
        this.#emit(operation, event);
      }

      if (!this.#isCurrent(operation)) {
        return canceledResult(operation);
      }

      const terminal = this.#emit(operation, {
        type: "assist_completed",
        metrics: createMetrics(operation, normalizeClock(this.now()))
      });
      operation.terminal = true;
      return Object.freeze({ status: "completed", event: terminal });
    } catch (error) {
      if (!this.#isCurrent(operation)) return canceledResult(operation);
      const publicError = sanitizeAssistError(error);
      const terminal = this.#emit(operation, { type: "assist_error", error: publicError });
      operation.terminal = true;
      return Object.freeze({ status: "error", event: terminal });
    } finally {
      if (this.inFlight === operation) this.inFlight = null;
    }
  }

  cancel(reason = "canceled") {
    if (!this.inFlight || this.inFlight.terminal) return false;
    if (!["canceled", "superseded", "session_reset"].includes(reason)) {
      throw new TypeError("The assistance cancellation reason is invalid.");
    }
    const operation = this.inFlight;
    operation.cancelReason = reason;
    operation.abortController.abort();
    const terminal = this.#emit(operation, { type: "assist_canceled", reason });
    operation.terminal = true;
    return terminal;
  }

  #isCurrent(operation) {
    return this.inFlight === operation && !operation.terminal && !operation.abortController.signal.aborted;
  }

  #emit(operation, payload) {
    operation.sequence += 1;
    const event = createAssistEvent({
      requestId: operation.requestId,
      sessionId: operation.sessionId,
      contextRevision: operation.contextRevision,
      sequence: operation.sequence
    }, payload);
    try {
      this.emit("event", event);
    } catch {
      // A disappearing renderer must not alter provider cancellation, context,
      // or terminal cleanup in the main process.
    }
    return event;
  }
}

export class AssistControllerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AssistControllerError";
    this.code = code;
  }
}

function createMetrics(operation, completedAt) {
  return Object.freeze({
    timeToFirstTokenMs: operation.firstTokenAt === null
      ? null
      : Math.max(0, operation.firstTokenAt - operation.startedAt),
    totalMs: Math.max(0, completedAt - operation.startedAt),
    outputChars: operation.outputChars
  });
}

function canceledResult(operation) {
  return Object.freeze({
    status: "canceled",
    requestId: operation.requestId,
    reason: operation.cancelReason ?? "canceled"
  });
}

function normalizeRequestId(value) {
  if (typeof value !== "string") throw new TypeError("The assistance request ID is invalid.");
  const requestId = value.trim();
  if (requestId.length === 0
    || requestId.length > ASSIST_LIMITS.maxIdentifierChars
    || /[\u0000-\u001f\u007f]/u.test(requestId)) {
    throw new TypeError("The assistance request ID is invalid.");
  }
  return requestId;
}

function normalizeClock(value) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError("The assistance clock is invalid.");
  return Math.round(value);
}

function isIterable(value) {
  return Boolean(value
    && (typeof value[Symbol.asyncIterator] === "function"
      || typeof value[Symbol.iterator] === "function"));
}

function providerProtocolError() {
  const error = new Error("Invalid provider stream.");
  error.code = "provider_protocol_error";
  return error;
}

function providerOutputTooLargeError() {
  const error = new Error("Provider output exceeded the local limit.");
  error.code = "provider_output_too_large";
  return error;
}
