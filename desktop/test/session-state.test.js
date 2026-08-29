import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveTrayState,
  InvalidSessionTransition,
  SessionState
} from "../renderer/lib/session-state.js";

test("tray state gives live capture precedence and reports effective setup failures", () => {
  const ready = {
    phase: "idle",
    captureActive: false,
    settingsReady: true,
    engineReady: true,
    catalogReady: true
  };

  assert.equal(deriveTrayState(ready), "idle");
  assert.equal(deriveTrayState({ ...ready, settingsReady: false }), "preparing");
  assert.equal(deriveTrayState({ ...ready, engineReady: false }), "error");
  assert.equal(deriveTrayState({ ...ready, catalogReady: false }), "error");
  assert.equal(deriveTrayState({ ...ready, phase: "starting" }), "preparing");
  assert.equal(deriveTrayState({ ...ready, phase: "starting", captureActive: true }), "transcribing");
  assert.equal(deriveTrayState({ ...ready, phase: "recording", captureActive: true }), "transcribing");
  assert.equal(deriveTrayState({ ...ready, phase: "recording" }), "error");
  assert.equal(deriveTrayState({ ...ready, phase: "stopping", captureActive: true }), "transcribing");
  assert.equal(deriveTrayState({ ...ready, phase: "stopping" }), "stopped");
});

test("the normal state path is explicit and repeatable", () => {
  const state = new SessionState();
  assert.equal(state.begin({ system: true, microphone: true }), true);
  assert.equal(state.phase, "starting");
  state.markRecording();
  assert.equal(state.phase, "recording");
  assert.equal(state.beginStop(), true);
  assert.equal(state.phase, "stopping");
  state.finishStop();
  assert.equal(state.phase, "stopped");
  assert.equal(state.active, false);
});

test("starting without any source yields an actionable error", () => {
  const state = new SessionState();
  assert.equal(state.begin({ system: false, microphone: false }), false);
  assert.equal(state.phase, "error");
  assert.equal(state.error.code, "no_source_selected");
  assert.equal(state.error.message, "Select meeting audio, microphone, or both.");
  assert.equal(state.resetError(), true);
  assert.equal(state.phase, "idle");
});

test("invalid transitions fail closed", () => {
  const state = new SessionState();
  assert.throws(() => state.markRecording(), InvalidSessionTransition);
  state.begin({ system: false, microphone: true });
  assert.throws(() => state.begin({ system: true, microphone: false }), InvalidSessionTransition);
  state.fail("input_interrupted", "The microphone was interrupted.");
  assert.equal(state.phase, "error");
  assert.equal(state.error.code, "input_interrupted");
});
