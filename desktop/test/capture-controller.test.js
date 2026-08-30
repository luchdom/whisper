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

test("one acquired source is active while a second selected source is still delayed", async () => {
  const systemStream = createStoppedStreamProbe();
  const microphoneStream = createStoppedStreamProbe();
  const activity = [];
  let releaseMicrophone;
  let microphoneRequests = 0;
  const delayedMicrophone = new Promise((resolve) => { releaseMicrophone = resolve; });
  const controller = new CaptureController({
    bridge: { sendAudio: async () => ({ ok: true }) },
    requesters: {
      system: async () => systemStream.stream,
      microphone: async () => {
        microphoneRequests += 1;
        return delayedMicrophone;
      }
    },
    onActivityChange: (active) => activity.push(active),
    now: () => 0
  });

  const starting = controller.start({ system: true, microphone: true });
  await waitFor(() => microphoneRequests === 1);

  assert.equal(controller.active, true);
  assert.equal(activity.at(-1), true);

  const stopping = controller.stop();
  releaseMicrophone(microphoneStream.stream);
  await stopping;
  await assert.rejects(starting, CaptureStartCancelled);

  assert.equal(systemStream.stopped, true);
  assert.equal(microphoneStream.stopped, true);
  assert.equal(controller.active, false);
  assert.equal(activity.at(-1), false);
});

test("packet watchdog starts only after attach and bounds a source with no first block", async () => {
  await withFakeAudioCapture(async () => {
    const timers = createFakeTimers();
    const probe = createObservedStreamProbe();
    const interruptions = [];
    let releaseMicrophone;
    let microphoneRequests = 0;
    const delayedMicrophone = new Promise((resolve) => { releaseMicrophone = resolve; });
    const controller = new CaptureController({
      bridge: { sendAudio: async () => ({ ok: true }) },
      requesters: {
        system: async () => probe.stream,
        microphone: async () => {
          microphoneRequests += 1;
          return delayedMicrophone;
        }
      },
      onInterruption: (track, error) => interruptions.push({ track, error }),
      now: timers.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      packetStallTimeoutMs: 100,
      trackMuteTimeoutMs: 50
    });

    const starting = controller.start({ system: false, microphone: true });
    await waitFor(() => microphoneRequests === 1);
    timers.advance(1_000);
    assert.equal(timers.pendingCount(), 0, "permission acquisition must not start the watchdog");
    assert.equal(interruptions.length, 0);

    releaseMicrophone(probe.stream);
    await starting;
    assert.equal(timers.pendingCount(), 1, "successful attach starts the first-block grace period");
    timers.advance(99);
    assert.equal(interruptions.length, 0);
    timers.advance(1);

    assert.equal(interruptions.length, 1);
    assert.equal(interruptions[0].error.code, "input_interrupted");
    await controller.stop();
  });
});

test("packet stall watchdog resets for each live audio block", async () => {
  await withFakeAudioCapture(async ({ contexts, worklets }) => {
    const timers = createFakeTimers();
    const probe = createObservedStreamProbe();
    const interruptions = [];
    const controller = new CaptureController({
      bridge: { sendAudio: async () => ({ ok: true }) },
      requesters: {
        system: async () => probe.stream,
        microphone: async () => probe.stream
      },
      onInterruption: (track, error) => interruptions.push({ track, error }),
      now: timers.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      packetStallTimeoutMs: 100,
      trackMuteTimeoutMs: 50
    });

    await controller.start({ system: false, microphone: true });
    assert.equal(contexts.length, 1);
    assert.equal(timers.pendingCount(), 1);

    worklets[0].emitAudio(new Float32Array(128));
    assert.equal(timers.pendingCount(), 1);
    timers.advance(99);
    assert.equal(interruptions.length, 0);

    worklets[0].emitAudio(new Float32Array(128));
    timers.advance(99);
    assert.equal(interruptions.length, 0, "a later block must reset the deadline");
    timers.advance(1);

    assert.equal(interruptions.length, 1);
    assert.equal(interruptions[0].track, "microphone");
    assert.equal(interruptions[0].error.code, "input_interrupted");
    await controller.stop();
    assert.equal(timers.pendingCount(), 0);
  });
});

test("short track mute is tolerated but a bounded mute reports one interruption", async () => {
  await withFakeAudioCapture(async ({ worklets }) => {
    const timers = createFakeTimers();
    const probe = createObservedStreamProbe();
    const interruptions = [];
    const controller = createObservedController({ probe, timers, interruptions });

    await controller.start({ system: false, microphone: true });
    worklets[0].emitAudio(new Float32Array(128));
    probe.track.setMuted(true);
    assert.equal(timers.pendingCount(), 1, "mute replaces the packet watchdog");
    timers.advance(49);
    assert.equal(interruptions.length, 0);

    probe.track.setMuted(false);
    worklets[0].emitAudio(new Float32Array(128));
    timers.advance(49);
    probe.track.setMuted(true);
    timers.advance(50);

    assert.equal(interruptions.length, 1);
    assert.equal(interruptions[0].error.code, "input_interrupted");

    probe.track.setMuted(false);
    worklets[0].emitAudio(new Float32Array(128));
    timers.advance(500);
    assert.equal(interruptions.length, 1, "unmute must not resume an interrupted capture");
    await controller.stop();
  });
});

test("track end and AudioContext suspension use the existing interruption boundary", async () => {
  await withFakeAudioCapture(async ({ contexts }) => {
    const timers = createFakeTimers();
    const endedProbe = createObservedStreamProbe();
    const endedInterruptions = [];
    const endedController = createObservedController({
      probe: endedProbe,
      timers,
      interruptions: endedInterruptions
    });

    await endedController.start({ system: false, microphone: true });
    endedProbe.track.end();
    assert.equal(endedInterruptions.length, 1);
    assert.equal(endedInterruptions[0].error.code, "input_interrupted");
    await endedController.stop();

    const suspendedProbe = createObservedStreamProbe();
    const suspendedInterruptions = [];
    const suspendedController = createObservedController({
      probe: suspendedProbe,
      timers,
      interruptions: suspendedInterruptions
    });
    await suspendedController.start({ system: false, microphone: true });
    contexts.at(-1).setState("suspended");

    assert.equal(suspendedInterruptions.length, 1);
    assert.equal(suspendedInterruptions[0].error.code, "audio_context_suspended");
    contexts.at(-1).setState("running");
    assert.equal(suspendedInterruptions.length, 1, "state recovery must not auto-resume the session");
    await suspendedController.stop();
  });
});

test("stop removes capture observers and timers before media teardown races", async () => {
  await withFakeAudioCapture(async ({ contexts, worklets }) => {
    const timers = createFakeTimers();
    const probe = createObservedStreamProbe();
    const interruptions = [];
    const controller = createObservedController({ probe, timers, interruptions });

    await controller.start({ system: false, microphone: true });
    worklets[0].emitAudio(new Float32Array(128));
    assert.equal(timers.pendingCount(), 1);

    await controller.stop();
    assert.equal(timers.pendingCount(), 0);
    assert.equal(probe.track.listenerCount(), 0);
    assert.equal(contexts[0].listenerCount(), 0);
    assert.equal(worklets[0].port.onmessage, null);

    probe.track.setMuted(true);
    probe.track.end();
    contexts[0].setState("suspended");
    timers.advance(1_000);
    assert.equal(interruptions.length, 0);
  });
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

function createObservedController({ probe, timers, interruptions }) {
  return new CaptureController({
    bridge: { sendAudio: async () => ({ ok: true }) },
    requesters: {
      system: async () => probe.stream,
      microphone: async () => probe.stream
    },
    onInterruption: (track, error) => interruptions.push({ track, error }),
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    packetStallTimeoutMs: 100,
    trackMuteTimeoutMs: 50
  });
}

function createObservedStreamProbe() {
  const track = new FakeMediaStreamTrack();
  return {
    track,
    stream: {
      getTracks: () => [track],
      getAudioTracks: () => [track],
      getVideoTracks: () => []
    }
  };
}

class FakeEventSource {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once: Boolean(options?.once) });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((entry) => entry.listener !== listener));
  }

  dispatch(type) {
    for (const entry of [...(this.listeners.get(type) ?? [])]) {
      if (entry.once) this.removeEventListener(type, entry.listener);
      entry.listener({ type, target: this });
    }
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.length, 0);
  }
}

class FakeMediaStreamTrack extends FakeEventSource {
  constructor() {
    super();
    this.muted = false;
    this.readyState = "live";
  }

  setMuted(muted) {
    if (this.readyState === "ended" || this.muted === muted) return;
    this.muted = muted;
    this.dispatch(muted ? "mute" : "unmute");
  }

  end() {
    if (this.readyState === "ended") return;
    this.readyState = "ended";
    this.dispatch("ended");
  }

  stop() {
    this.end();
  }
}

function createFakeTimers() {
  let clockMs = 0;
  let nextId = 1;
  const tasks = new Map();

  return {
    now: () => clockMs,
    setTimer(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { callback, dueMs: clockMs + delayMs });
      return id;
    },
    clearTimer(id) {
      tasks.delete(id);
    },
    advance(durationMs) {
      const targetMs = clockMs + durationMs;
      while (true) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.dueMs <= targetMs)
          .sort((left, right) => left[1].dueMs - right[1].dueMs || left[0] - right[0])[0];
        if (!due) break;
        const [id, task] = due;
        clockMs = task.dueMs;
        tasks.delete(id);
        task.callback();
      }
      clockMs = targetMs;
    },
    pendingCount: () => tasks.size
  };
}

async function withFakeAudioCapture(run) {
  const contexts = [];
  const worklets = [];
  const originals = new Map();

  class FakeAudioNode {
    connect(destination) {
      return destination;
    }

    disconnect() {}
  }

  class FakeAudioContext extends FakeEventSource {
    constructor() {
      super();
      this.state = "running";
      this.sampleRate = 48_000;
      this.destination = new FakeAudioNode();
      this.audioWorklet = { addModule: async () => {} };
      contexts.push(this);
    }

    createMediaStreamSource() {
      return new FakeAudioNode();
    }

    createGain() {
      const gain = new FakeAudioNode();
      gain.gain = { value: 1 };
      return gain;
    }

    async resume() {
      this.setState("running");
    }

    async close() {
      this.setState("closed");
    }

    setState(state) {
      if (this.state === state) return;
      this.state = state;
      this.dispatch("statechange");
    }
  }

  class FakeAudioWorkletNode extends FakeAudioNode {
    constructor() {
      super();
      this.port = { onmessage: null };
      worklets.push(this);
    }

    emitAudio(samples) {
      this.port.onmessage?.({ data: { type: "audio-block", samples } });
    }
  }

  class FakeMediaStream {
    constructor(tracks) {
      this.tracks = tracks;
    }
  }

  for (const [name, value] of [
    ["AudioContext", FakeAudioContext],
    ["AudioWorkletNode", FakeAudioWorkletNode],
    ["MediaStream", FakeMediaStream]
  ]) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  try {
    return await run({ contexts, worklets });
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail("Timed out waiting for the capture request.");
}
