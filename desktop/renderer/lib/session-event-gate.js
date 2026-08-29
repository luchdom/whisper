export class SessionEventGate {
  constructor() {
    this.activeSessionId = null;
  }

  beginStart() {
    this.activeSessionId = null;
  }

  activate(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("A non-empty backend session id is required.");
    }
    this.activeSessionId = sessionId;
  }

  accepts(event) {
    return this.activeSessionId !== null && event?.session_id === this.activeSessionId;
  }

  clear() {
    this.activeSessionId = null;
  }
}
