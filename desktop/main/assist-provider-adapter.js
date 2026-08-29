export function createAssistProviderAdapter({ providerController } = {}) {
  if (!providerController || typeof providerController.requestAssist !== "function") {
    throw new TypeError("A provider controller is required for assistance.");
  }

  return Object.freeze({
    streamAssist(request, { signal } = {}) {
      return createProviderStream(providerController, request, signal);
    }
  });
}

async function* createProviderStream(providerController, request, externalSignal) {
  const operation = new AbortController();
  const removeExternalAbort = linkAbortSignal(externalSignal, operation);
  const channel = new RendezvousChannel();
  let sawDelta = false;

  const producer = providerController.requestAssist({
    sessionId: request.sessionId,
    contextSnapshot: request.contextSnapshot,
    question: request.intent.question,
    signal: operation.signal,
    onEvent: async (event) => {
      if (event.type !== "delta") return;
      sawDelta = true;
      await channel.send(Object.freeze({
        type: "delta",
        channel: "suggestion",
        delta: event.delta
      }));
    }
  }).then(async (result) => {
    if (!sawDelta && typeof result.text === "string" && result.text.trim().length > 0) {
      await channel.send(Object.freeze({
        type: "item",
        channel: "suggestion",
        text: result.text,
        citations: Object.freeze([])
      }));
    }
    channel.close();
    return result;
  }).catch((error) => {
    channel.fail(error);
    throw error;
  });
  producer.catch(() => {});

  try {
    while (true) {
      const item = await channel.receive();
      if (item.done) break;
      yield item.value;
    }
    await producer;
  } finally {
    removeExternalAbort();
    operation.abort();
    channel.close();
    await producer.catch(() => {});
  }
}

class RendezvousChannel {
  constructor() {
    this.pending = null;
    this.receiver = null;
    this.closed = false;
    this.failure = null;
  }

  send(value) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(abortedError());
    if (this.pending) {
      return Promise.reject(new Error("Assistance stream backpressure invariant failed."));
    }
    if (this.receiver) {
      const receiver = this.receiver;
      this.receiver = null;
      receiver.resolve({ done: false, value });
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.pending = { value, resolve, reject };
    });
  }

  receive() {
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      pending.resolve();
      return Promise.resolve({ done: false, value: pending.value });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    if (this.receiver) {
      return Promise.reject(new Error("Assistance stream already has a consumer."));
    }
    return new Promise((resolve, reject) => {
      this.receiver = { resolve, reject };
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) {
      this.pending.reject(abortedError());
      this.pending = null;
    }
    if (this.receiver) {
      this.receiver.resolve({ done: true, value: undefined });
      this.receiver = null;
    }
  }

  fail(error) {
    if (this.closed || this.failure) return;
    this.failure = error;
    if (this.pending) {
      this.pending.reject(error);
      this.pending = null;
    }
    if (this.receiver) {
      this.receiver.reject(error);
      this.receiver = null;
    }
  }
}

function linkAbortSignal(externalSignal, controller) {
  if (!externalSignal) return () => {};
  const abort = () => controller.abort();
  if (externalSignal.aborted) abort();
  else externalSignal.addEventListener("abort", abort, { once: true });
  return () => externalSignal.removeEventListener("abort", abort);
}

function abortedError() {
  const error = new Error("The assistance request was canceled.");
  error.code = "provider_request_aborted";
  return error;
}
