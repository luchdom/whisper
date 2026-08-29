import { isTerminalAssistEvent, validateAssistEvent } from "../../main/assist-protocol.js";

export const ASSIST_TERMINAL_DELIVERY_TIMEOUT_MS = 2_000;

export class AssistRequestCanceledError extends Error {
  constructor() {
    super("Assistance canceled before any meeting context was sent.");
    this.name = "AssistRequestCanceledError";
  }
}

export class AssistTerminalDeliveryTimeoutError extends Error {
  constructor() {
    super("Assistance ended without a verified completion event.");
    this.name = "AssistTerminalDeliveryTimeoutError";
  }
}

export class AssistRequestSupersededError extends Error {
  constructor() {
    super("Assistance was superseded by a meeting transition.");
    this.name = "AssistRequestSupersededError";
  }
}

export class AssistRequestAttempt {
  constructor({ deliveryTimeoutMs = ASSIST_TERMINAL_DELIVERY_TIMEOUT_MS } = {}) {
    if (!Number.isSafeInteger(deliveryTimeoutMs) || deliveryTimeoutMs <= 0) {
      throw new TypeError("A positive terminal delivery timeout is required.");
    }
    this.deliveryTimeoutMs = deliveryTimeoutMs;
    this.context = null;
    this.request = null;
    this.dispatched = false;
    this.canceled = false;
    this.closed = false;
    this.superseded = false;
    this.terminalEvent = null;
    this.waiters = new Set();
  }

  bindContext(sessionId, contextRevision) {
    if (this.closed || this.context || this.dispatched) return false;
    this.context = Object.freeze({
      sessionId: normalizeIdentifier(sessionId),
      contextRevision: normalizeRevision(contextRevision)
    });
    return true;
  }

  cancel() {
    if (this.closed) return false;
    this.canceled = true;
    return !this.dispatched;
  }

  supersede() {
    if (this.closed) return false;
    this.closed = true;
    this.superseded = true;
    const error = new AssistRequestSupersededError();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
    return true;
  }

  throwIfCanceledBeforeDispatch() {
    if (this.canceled && !this.dispatched) throw new AssistRequestCanceledError();
  }

  markDispatched() {
    this.throwIfCanceledBeforeDispatch();
    if (this.closed || !this.context || this.dispatched) return false;
    this.dispatched = true;
    return true;
  }

  bindStarted(value) {
    let event;
    try {
      event = validateAssistEvent(value);
    } catch {
      return false;
    }
    if (this.closed || !this.dispatched || this.request || event.type !== "assist_started") return false;
    if (event.sessionId !== this.context.sessionId
      || event.contextRevision !== this.context.contextRevision) {
      return false;
    }
    this.request = Object.freeze({
      requestId: event.requestId,
      sessionId: event.sessionId,
      contextRevision: event.contextRevision
    });
    return true;
  }

  acceptTerminal(value) {
    let event;
    try {
      event = validateAssistEvent(value);
    } catch {
      return false;
    }
    if (this.closed || !this.request || this.terminalEvent || !isTerminalAssistEvent(event)) return false;
    if (event.requestId !== this.request.requestId
      || event.sessionId !== this.request.sessionId
      || event.contextRevision !== this.request.contextRevision) {
      return false;
    }
    this.terminalEvent = event;
    this.closed = true;
    for (const waiter of this.waiters) waiter.resolve(event);
    this.waiters.clear();
    return true;
  }

  waitForTerminal() {
    if (this.terminalEvent) return Promise.resolve(this.terminalEvent);
    if (this.superseded) return Promise.reject(new AssistRequestSupersededError());
    if (this.closed) return Promise.reject(new Error("Assistance event delivery is closed."));
    if (!this.dispatched) {
      return Promise.reject(new Error("Assistance was not dispatched."));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        timer: null,
        resolve: (event) => {
          clearTimeout(waiter.timer);
          resolve(event);
        },
        reject
      };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        this.closed = true;
        reject(new AssistTerminalDeliveryTimeoutError());
      }, this.deliveryTimeoutMs);
      this.waiters.add(waiter);
    });
  }

  finish() {
    this.closed = true;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Assistance event delivery ended early."));
    }
    this.waiters.clear();
  }
}

export class AssistStatusGenerationGate {
  constructor() {
    this.generation = 0;
    this.sessionGeneration = 0;
    this.sessionId = null;
  }

  transition(sessionId) {
    this.sessionId = normalizeOptionalIdentifier(sessionId);
    this.generation += 1;
    this.sessionGeneration += 1;
    return this.capture();
  }

  invalidate() {
    this.generation += 1;
    return this.capture();
  }

  capture() {
    return Object.freeze({
      generation: this.generation,
      sessionGeneration: this.sessionGeneration,
      sessionId: this.sessionId
    });
  }

  isCurrent(identity) {
    return Boolean(identity
      && identity.generation === this.generation
      && identity.sessionGeneration === this.sessionGeneration
      && identity.sessionId === this.sessionId);
  }

  isSameSession(identity) {
    return Boolean(identity
      && identity.sessionGeneration === this.sessionGeneration
      && identity.sessionId === this.sessionId);
  }

  accepts(identity, responseSessionId) {
    let normalizedResponseSessionId;
    try {
      normalizedResponseSessionId = normalizeOptionalIdentifier(responseSessionId);
    } catch {
      return false;
    }
    return this.isCurrent(identity)
      && normalizedResponseSessionId === identity.sessionId;
  }
}

export class AssistRequestGate {
  constructor() {
    this.sessionId = null;
    this.transcriptRevision = 0;
    this.activeRequest = null;
    this.pendingRevisionFloor = null;
  }

  activateSession(sessionId, transcriptRevision = 0) {
    this.sessionId = normalizeIdentifier(sessionId);
    this.transcriptRevision = normalizeRevision(transcriptRevision);
    this.activeRequest = null;
    this.pendingRevisionFloor = null;
  }

  endSession(sessionId = this.sessionId) {
    if (this.sessionId === null || sessionId !== this.sessionId) return false;
    this.sessionId = null;
    this.transcriptRevision = 0;
    this.activeRequest = null;
    this.pendingRevisionFloor = null;
    return true;
  }

  advanceTranscript(revision) {
    const next = normalizeRevision(revision);
    if (next < this.transcriptRevision) return false;
    this.transcriptRevision = next;
    return true;
  }

  beginRequest(contextRevision = this.transcriptRevision) {
    if (this.sessionId === null) return false;
    this.pendingRevisionFloor = normalizeRevision(contextRevision);
    this.activeRequest = null;
    return Object.freeze({
      sessionId: this.sessionId,
      minimumContextRevision: this.pendingRevisionFloor
    });
  }

  accepts(value) {
    if (this.sessionId === null) return false;

    let event;
    try {
      event = validateAssistEvent(value);
    } catch {
      return false;
    }
    if (event.sessionId !== this.sessionId) return false;

    if (event.type === "assist_started") {
      if (this.pendingRevisionFloor === null) return false;
      if (event.sequence !== 1
        || event.contextRevision !== this.pendingRevisionFloor) return false;
      if (this.activeRequest?.requestId === event.requestId) return false;
      this.activeRequest = {
        requestId: event.requestId,
        contextRevision: event.contextRevision,
        nextSequence: 2,
        terminal: false
      };
      this.pendingRevisionFloor = null;
      return true;
    }

    const active = this.activeRequest;
    if (!active || active.terminal) return false;
    if (event.requestId !== active.requestId
      || event.contextRevision !== active.contextRevision
      || event.sequence !== active.nextSequence) {
      return false;
    }

    active.nextSequence += 1;
    if (isTerminalAssistEvent(event)) active.terminal = true;
    return true;
  }
}

function normalizeIdentifier(value) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new TypeError("A valid assistance session ID is required.");
  }
  return value.trim();
}

function normalizeOptionalIdentifier(value) {
  return value === null ? null : normalizeIdentifier(value);
}

function normalizeRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("A non-negative transcript revision is required.");
  }
  return value;
}
