import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventGate } from "../renderer/lib/session-event-gate.js";

test("late transcript and stop events from an old session cannot affect a restart", () => {
  const gate = new SessionEventGate();
  gate.activate("old-session");
  assert.equal(gate.accepts({ type: "final_segment", session_id: "old-session" }), true);

  gate.beginStart();
  assert.equal(gate.accepts({ type: "final_segment", session_id: "old-session" }), false);
  gate.activate("new-session");
  assert.equal(gate.accepts({ type: "final_segment", session_id: "old-session" }), false);
  assert.equal(gate.accepts({ type: "session_stopped", session_id: "old-session" }), false);
  assert.equal(gate.accepts({ type: "final_segment", session_id: "new-session" }), true);
  assert.equal(gate.accepts({ type: "session_stopped", session_id: "new-session" }), true);
});

test("null or missing session ids fail closed", () => {
  const gate = new SessionEventGate();
  assert.throws(() => gate.activate(null), TypeError);
  gate.activate("active");
  assert.equal(gate.accepts({ type: "final_segment" }), false);
  assert.equal(gate.accepts({ type: "final_segment", session_id: null }), false);
});
