export class StartAttemptGate {
  constructor() {
    this.generation = 0;
    this.closing = false;
    this.controller = null;
  }

  begin() {
    if (this.closing) throw new StartAttemptCancelled();
    this.abortCurrent();
    this.generation += 1;
    this.controller = new AbortController();
    return this.generation;
  }

  signalFor(generation) {
    this.assertCurrent(generation);
    return this.controller.signal;
  }

  cancelCurrent() {
    this.generation += 1;
    this.abortCurrent();
  }

  cancelAll() {
    this.closing = true;
    this.cancelCurrent();
  }

  assertCurrent(generation) {
    if (this.closing || generation !== this.generation) throw new StartAttemptCancelled();
  }

  abortCurrent() {
    const controller = this.controller;
    this.controller = null;
    if (controller && !controller.signal.aborted) {
      controller.abort(new StartAttemptCancelled());
    }
  }
}

export class StartAttemptCancelled extends Error {
  constructor() {
    super("Session start was cancelled.");
    this.name = "StartAttemptCancelled";
  }
}
