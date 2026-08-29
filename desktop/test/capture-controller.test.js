import assert from "node:assert/strict";
import test from "node:test";
import {
  CaptureController,
  CaptureStartCancelled,
  MeetingCaptureError,
  nextPacketTiming,
  sourceStartOffset
} from "../renderer/capture-controller.js";

test("odd final packet sizes produce contiguous integral backend timestamps", () => {
  const full = nextPacketTiming(0, 3_200);
  const oddFinal = nextPacketTiming(full.endMs, 17);
  const nextSessionPacket = nextPacketTiming(oddFinal.endMs, 3_200);

  assert.deepEqual(full, { startMs: 0, endMs: 200 });
  assert.deepEqual(oddFinal, { startMs: 200, endMs: 201 });
  assert.deepEqual(nextSessionPacket, { startMs: 201, endMs: 401 });
  assert.equal(Number.isInteger(oddFinal.startMs), true);
  assert.equal(Number.isInteger(oddFinal.endMs), true);
});

test("separately attached sources share one monotonic session epoch", () => {
  assert.equal(sourceStartOffset(1_000, 1_012.4), 12);
  assert.equal(sourceStartOffset(1_000, 1_437.8), 438);
  assert.equal(sourceStartOffset(1_000, 999), 0);
});

for (const [track, expectedText] of [
  ["system", /screen and audio capture/i],
  ["microphone", /microphone access/i]
]) {
  test(`${track} permission denial is preserved as a source-specific actionable error`, async () => {
    const sourceStates = [];
    const controller = new CaptureController({
      bridge: { sendAudio: async () => ({ ok: true }) },
      requesters: {
        system: async () => { throw new DOMException("denied", "NotAllowedError"); },
        microphone: async () => { throw new DOMException("denied", "NotAllowedError"); }
      },
      onSourceState: (...state) => sourceStates.push(state),
      now: () => 0
    });

    await assert.rejects(
      controller.start({ system: track === "system", microphone: track === "microphone" }),
      (error) => {
        assert.equal(error instanceof MeetingCaptureError, true);
        assert.equal(error.code, "permission_denied");
        assert.equal(error.track, track);
        assert.match(error.message, expectedText);
        return true;
      }
    );
    assert.equal(sourceStates.at(-1)[0], track);
    assert.equal(sourceStates.at(-1)[1], "error");
    assert.match(sourceStates.at(-1)[2], expectedText);
  });
}

test("stop cancels delayed system acquisition before requesting or attaching another source", async () => {
  const systemStream = createStoppedStreamProbe();
  let releaseSystem;
  let systemRequests = 0;
  let microphoneRequests = 0;
  const delayedSystem = new Promise((resolve) => { releaseSystem = resolve; });
  const controller = new CaptureController({
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

  const starting = controller.start({ system: true, microphone: true });
  await waitFor(() => systemRequests === 1);
  const stopping = controller.stop();
  releaseSystem(systemStream.stream);

  await stopping;
  await assert.rejects(starting, CaptureStartCancelled);
  assert.equal(microphoneRequests, 0);
  assert.equal(systemStream.stopped, true);
  assert.equal(controller.active, false);
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
