import assert from "node:assert/strict";
import test from "node:test";
import { CaptureController } from "../renderer/capture-controller.js";
import { StartAttemptCancelled, StartAttemptGate } from "../renderer/lib/start-attempt.js";

test("a delayed backend start cannot continue into capture after close cancellation", async () => {
  const gate = new StartAttemptGate();
  const generation = gate.begin();
  let releaseBackend;
  const delayedBackend = new Promise((resolve) => { releaseBackend = resolve; });
  let captureStarted = false;

  const attempt = (async () => {
    await delayedBackend;
    gate.assertCurrent(generation);
    captureStarted = true;
  })();

  gate.cancelAll();
  releaseBackend();
  await assert.rejects(attempt, StartAttemptCancelled);
  assert.equal(captureStarted, false);
});

test("close cancellation aborts a delayed permission request before another source is requested", async () => {
  const gate = new StartAttemptGate();
  const generation = gate.begin();
  const signal = gate.signalFor(generation);
  const systemStream = createStoppedStreamProbe();
  let releaseSystem;
  let systemRequests = 0;
  let microphoneRequests = 0;
  const delayedSystem = new Promise((resolve) => { releaseSystem = resolve; });
  const capture = new CaptureController({
    bridge: { sendAudio: async () => ({ ok: true }) },
    requesters: {
      system: async () => {
        systemRequests += 1;
        return delayedSystem;
      },
      microphone: async () => {
        microphoneRequests += 1;
        return createStoppedStreamProbe().stream;
      }
    },
    now: () => 0
  });

  const starting = capture.start({ system: true, microphone: true }, { signal });
  await waitFor(() => systemRequests === 1);
  gate.cancelAll();
  assert.equal(signal.aborted, true);
  releaseSystem(systemStream.stream);

  await assert.rejects(starting, StartAttemptCancelled);
  assert.equal(microphoneRequests, 0);
  assert.equal(systemStream.stopped, true);
  assert.equal(capture.active, false);
});

function createStoppedStreamProbe() {
  let stopCount = 0;
  const track = { stop: () => { stopCount += 1; } };
  return {
    stream: {
      getTracks: () => [track],
      getAudioTracks: () => [track],
      getVideoTracks: () => []
    },
    get stopped() {
      return stopCount > 0;
    }
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail("Timed out waiting for the capture request.");
}
