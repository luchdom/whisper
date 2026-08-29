const ACTIVE_PHASES = new Set(["starting", "recording", "stopping"]);

export class SessionState {
  constructor() {
    this.phase = "idle";
    this.error = null;
  }

  get active() {
    return ACTIVE_PHASES.has(this.phase);
  }

  begin(selectedSources) {
    if (this.active) throw new InvalidSessionTransition("A session is already active.");
    if (!selectedSources?.system && !selectedSources?.microphone) {
      this.phase = "error";
      this.error = {
        code: "no_source_selected",
        message: "Select meeting audio, microphone, or both."
      };
      return false;
    }
    this.phase = "starting";
    this.error = null;
    return true;
  }

  markRecording() {
    this.assertPhase("starting", "recording");
    this.phase = "recording";
  }

  beginStop() {
    if (this.phase === "stopping") return false;
    if (!ACTIVE_PHASES.has(this.phase) && this.phase !== "error") return false;
    this.phase = "stopping";
    return true;
  }

  finishStop() {
    if (this.phase !== "stopping" && this.phase !== "error") {
      throw new InvalidSessionTransition(`Cannot finish stopping from ${this.phase}.`);
    }
    this.phase = "idle";
    this.error = null;
  }

  fail(code, message) {
    this.phase = "error";
    this.error = { code, message };
  }

  resetError() {
    if (this.phase !== "error") return false;
    this.phase = "idle";
    this.error = null;
    return true;
  }

  assertPhase(expected, action) {
    if (this.phase !== expected) {
      throw new InvalidSessionTransition(`Cannot enter ${action} from ${this.phase}.`);
    }
  }
}

export class InvalidSessionTransition extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidSessionTransition";
  }
}
