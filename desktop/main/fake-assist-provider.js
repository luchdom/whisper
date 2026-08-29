export function createFakeAssistProvider({ delayMs = 15 } = {}) {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new TypeError("Fake assistance delay must be a non-negative integer.");
  }
  return Object.freeze({
    streamAssist(request, { signal } = {}) {
      return fakeStream(request, signal, delayMs);
    }
  });
}

async function* fakeStream(request, signal, delayMs) {
  const chunks = ["A concise response: ", request.intent.question];
  for (const delta of chunks) {
    await wait(delayMs, signal);
    yield Object.freeze({ type: "delta", channel: "suggestion", delta });
  }
}

function wait(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(abortedError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function abortedError() {
  const error = new Error("The fake assistance request was canceled.");
  error.code = "provider_request_aborted";
  return error;
}
