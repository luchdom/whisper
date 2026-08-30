import { StreamingAudioPipeline, TRANSCRIPTION_SAMPLE_RATE } from "./lib/audio-pipeline.js";

const PROCESSOR_NAME = "transcription-capture";
const DEFAULT_PACKET_STALL_TIMEOUT_MS = 5_000;
const DEFAULT_TRACK_MUTE_TIMEOUT_MS = 2_000;

export class CaptureController {
  constructor({
    bridge,
    onSourceState = () => {},
    onActivityChange = () => {},
    onInterruption = () => {},
    requesters,
    now = () => performance.now(),
    setTimer = (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer = (handle) => globalThis.clearTimeout(handle),
    packetStallTimeoutMs = DEFAULT_PACKET_STALL_TIMEOUT_MS,
    trackMuteTimeoutMs = DEFAULT_TRACK_MUTE_TIMEOUT_MS
  }) {
    this.bridge = bridge;
    this.onSourceState = onSourceState;
    this.onActivityChange = onActivityChange;
    this.onInterruption = onInterruption;
    this.requesters = requesters ?? {
      system: requestSystemAudio,
      microphone: requestMicrophone
    };
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.packetStallTimeoutMs = positiveTimeout(packetStallTimeoutMs, "packetStallTimeoutMs");
    this.trackMuteTimeoutMs = positiveTimeout(trackMuteTimeoutMs, "trackMuteTimeoutMs");
    this.sources = new Map();
    this.pendingSends = new Set();
    this.stopping = false;
    this.interruptionReported = false;
    this.sessionOriginMs = 0;
    this.startAttempt = null;
    this.stopPromise = null;
  }

  get active() {
    return this.sources.size > 0 || (this.startAttempt?.acquired.size ?? 0) > 0;
  }

  async start(selection, { signal } = {}) {
    if (this.active || this.startAttempt || this.stopPromise) {
      throw new Error("Audio capture is already active or changing state.");
    }
    this.stopping = false;
    this.interruptionReported = false;
    const attempt = {
      acquired: new Map(),
      cancelled: false,
      reason: null,
      signal,
      onAbort: null
    };
    attempt.onAbort = () => this.cancelAttempt(attempt, signal?.reason);
    this.startAttempt = attempt;
    signal?.addEventListener("abort", attempt.onAbort, { once: true });
    if (signal?.aborted) attempt.onAbort();

    try {
      if (selection.system) {
        attempt.acquired.set("system", await this.acquire("system", attempt));
        this.onActivityChange(this.active);
      }
      if (selection.microphone) {
        attempt.acquired.set("microphone", await this.acquire("microphone", attempt));
        this.onActivityChange(this.active);
      }

      // Permissions are acquired before audio processing starts. Both tracks
      // then share one session clock while retaining their actual attach offset.
      this.assertAttemptCurrent(attempt);
      this.sessionOriginMs = this.now();
      for (const [track, stream] of attempt.acquired) {
        this.assertAttemptCurrent(attempt);
        try {
          await this.attach(track, stream, () => this.assertAttemptCurrent(attempt));
          this.assertAttemptCurrent(attempt);
        } catch (error) {
          this.assertAttemptCurrent(attempt);
          const issue = describeCaptureError(error, track);
          this.onSourceState(track, "error", issue.message);
          throw issue;
        }
      }
    } catch (error) {
      for (const [track, stream] of attempt.acquired) {
        if (![...this.sources.values()].some((source) => source.stream === stream)) {
          stopMediaStream(stream);
          attempt.acquired.delete(track);
        }
      }
      this.onActivityChange(this.active);
      await this.stop().catch(() => {});
      throw error;
    } finally {
      signal?.removeEventListener("abort", attempt.onAbort);
      if (this.startAttempt === attempt) this.startAttempt = null;
      this.onActivityChange(this.active);
    }
  }

  async acquire(track, attempt) {
    this.assertAttemptCurrent(attempt);
    this.onSourceState(track, "requesting", "Waiting for permission…");
    let stream;
    try {
      stream = await this.requesters[track]();
    } catch (error) {
      this.assertAttemptCurrent(attempt);
      const issue = describeCaptureError(error, track);
      this.onSourceState(track, "error", issue.message);
      throw issue;
    }
    try {
      this.assertAttemptCurrent(attempt);
    } catch (error) {
      stopMediaStream(stream);
      throw error;
    }
    return stream;
  }

  async attach(track, stream, assertCurrent = () => {}) {
    assertCurrent();
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      stopMediaStream(stream);
      throw captureError(track, "source_unavailable");
    }

    const context = new AudioContext({ latencyHint: "interactive" });
    let source = null;
    try {
      await context.audioWorklet.addModule(new URL("./audio-worklet.js", import.meta.url));
      assertCurrent();
      const sourceNode = context.createMediaStreamSource(new MediaStream([audioTrack]));
      const workletNode = new AudioWorkletNode(context, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      sourceNode.connect(workletNode).connect(silentGain).connect(context.destination);

      assertCurrent();
      if (context.state !== "running") {
        await context.resume();
        assertCurrent();
      }
      if (context.state !== "running") {
        throw captureError(track, "audio_context_suspended");
      }

      const pipeline = new StreamingAudioPipeline({ sourceSampleRate: context.sampleRate });
      source = {
        track,
        stream,
        audioTrack,
        context,
        sourceNode,
        workletNode,
        silentGain,
        pipeline,
        nextPacketMs: sourceStartOffset(this.sessionOriginMs, this.now()),
        lastPacketAtMs: this.now(),
        muted: Boolean(audioTrack.muted),
        packetStallTimer: null,
        trackMuteTimer: null,
        monitoring: true,
        onEnded: null,
        onMute: null,
        onUnmute: null,
        onContextStateChange: null
      };
      source.onEnded = () => this.reportInterruption(track, captureError(track, "input_interrupted"));
      source.onMute = () => this.observeTrackMute(source);
      source.onUnmute = () => this.observeTrackUnmute(source);
      source.onContextStateChange = () => this.observeContextState(source);
      audioTrack.addEventListener("ended", source.onEnded, { once: true });
      audioTrack.addEventListener("mute", source.onMute);
      audioTrack.addEventListener("unmute", source.onUnmute);
      context.addEventListener("statechange", source.onContextStateChange);
      workletNode.port.onmessage = ({ data }) => {
        if (
          data?.type !== "audio-block" ||
          !(data.samples instanceof Float32Array) ||
          !this.isMonitoredSource(source) ||
          source.muted ||
          source.context.state !== "running"
        ) return;
        this.observeLivePacket(source);
        try {
          for (const packet of pipeline.push(data.samples)) this.queuePacket(source, packet);
        } catch (error) {
          this.reportInterruption(track, error);
        }
      };
      this.sources.set(track, source);
      if (source.muted) this.observeTrackMute(source);
      else this.armPacketStallWatchdog(source);
      this.onSourceState(track, "capturing", "Capturing");
    } catch (error) {
      const registered = this.sources.get(track);
      if (source) this.cleanupSourceMonitoring(source);
      if (registered) {
        registered.sourceNode.disconnect();
        registered.workletNode.disconnect();
        registered.silentGain.disconnect();
        this.sources.delete(track);
      }
      stopMediaStream(stream);
      await context.close().catch(() => {});
      throw error;
    }
  }

  observeLivePacket(source) {
    if (!this.isMonitoredSource(source) || source.muted || source.context.state !== "running") return;
    source.lastPacketAtMs = this.now();
    this.armPacketStallWatchdog(source);
  }

  observeTrackMute(source) {
    if (!this.isMonitoredSource(source)) return;
    source.muted = true;
    this.clearSourceTimer(source, "packetStallTimer");
    this.clearSourceTimer(source, "trackMuteTimer");
    source.trackMuteTimer = this.setTimer(() => {
      source.trackMuteTimer = null;
      if (!this.isMonitoredSource(source) || !source.muted) return;
      this.reportInterruption(source.track, captureError(source.track, "input_interrupted"));
    }, this.trackMuteTimeoutMs);
  }

  observeTrackUnmute(source) {
    if (!this.isMonitoredSource(source)) return;
    source.muted = false;
    this.clearSourceTimer(source, "trackMuteTimer");
    if (source.context.state !== "running") return;
    source.lastPacketAtMs = this.now();
    this.armPacketStallWatchdog(source);
  }

  observeContextState(source) {
    if (!this.isMonitoredSource(source)) return;
    if (source.context.state === "running") {
      if (!source.muted) {
        source.lastPacketAtMs = this.now();
        this.armPacketStallWatchdog(source);
      }
      return;
    }
    this.clearSourceTimer(source, "packetStallTimer");
    this.clearSourceTimer(source, "trackMuteTimer");
    this.reportInterruption(source.track, captureError(source.track, "audio_context_suspended"));
  }

  armPacketStallWatchdog(source) {
    this.clearSourceTimer(source, "packetStallTimer");
    if (
      !this.isMonitoredSource(source) ||
      source.muted ||
      source.context.state !== "running"
    ) return;

    const elapsedMs = Math.max(0, this.now() - source.lastPacketAtMs);
    const remainingMs = Math.max(1, this.packetStallTimeoutMs - elapsedMs);
    source.packetStallTimer = this.setTimer(() => {
      source.packetStallTimer = null;
      if (
        !this.isMonitoredSource(source) ||
        source.muted ||
        source.context.state !== "running"
      ) return;
      if (this.now() - source.lastPacketAtMs < this.packetStallTimeoutMs) {
        this.armPacketStallWatchdog(source);
        return;
      }
      this.reportInterruption(source.track, captureError(source.track, "input_interrupted"));
    }, remainingMs);
  }

  isMonitoredSource(source) {
    return (
      source.monitoring &&
      !this.stopping &&
      !this.interruptionReported &&
      this.sources.get(source.track) === source
    );
  }

  clearSourceTimer(source, name) {
    if (source[name] == null) return;
    this.clearTimer(source[name]);
    source[name] = null;
  }

  cleanupSourceMonitoring(source) {
    source.monitoring = false;
    this.clearSourceTimer(source, "packetStallTimer");
    this.clearSourceTimer(source, "trackMuteTimer");
    source.audioTrack.removeEventListener("ended", source.onEnded);
    source.audioTrack.removeEventListener("mute", source.onMute);
    source.audioTrack.removeEventListener("unmute", source.onUnmute);
    source.context.removeEventListener("statechange", source.onContextStateChange);
  }

  queuePacket(source, packet) {
    const { startMs, endMs } = nextPacketTiming(source.nextPacketMs, packet.sampleCount);
    source.nextPacketMs = endMs;

    const operation = this.bridge.sendAudio({
      track: source.track,
      startMs,
      endMs,
      pcm: packet.pcm
    }).then((result) => {
      if (!result?.ok) throw new Error(result?.error || "Audio packet was rejected.");
    });
    this.pendingSends.add(operation);
    operation
      .catch((error) => this.reportInterruption(source.track, error))
      .finally(() => this.pendingSends.delete(operation));
  }

  cancelStart(reason = new CaptureStartCancelled()) {
    if (!this.startAttempt) return false;
    this.cancelAttempt(this.startAttempt, reason);
    return true;
  }

  cancelAttempt(attempt, reason) {
    if (attempt.cancelled) return;
    attempt.cancelled = true;
    attempt.reason = reason instanceof Error ? reason : new CaptureStartCancelled();
    this.stopping = true;
    for (const stream of attempt.acquired.values()) stopMediaStream(stream);
    attempt.acquired.clear();
    this.onActivityChange(this.active);
  }

  assertAttemptCurrent(attempt) {
    if (this.startAttempt !== attempt || attempt.cancelled || attempt.signal?.aborted) {
      throw attempt.reason ?? attempt.signal?.reason ?? new CaptureStartCancelled();
    }
  }

  stop() {
    this.cancelStart();
    if (this.stopPromise) return this.stopPromise;
    const operation = this.performStop();
    const stopPromise = operation.finally(() => {
      if (this.stopPromise === stopPromise) this.stopPromise = null;
    });
    this.stopPromise = stopPromise;
    return stopPromise;
  }

  async performStop() {
    this.stopping = true;
    const sources = [...this.sources.values()];

    // End capture before producing the final partial PCM packet.
    for (const source of sources) {
      this.cleanupSourceMonitoring(source);
      stopMediaStream(source.stream);
    }
    for (const source of sources) {
      source.workletNode.port.onmessage = null;
      for (const packet of source.pipeline.flush()) this.queuePacket(source, packet);
    }

    const sends = [...this.pendingSends];
    const results = await Promise.allSettled(sends);

    for (const source of sources) {
      source.sourceNode.disconnect();
      source.workletNode.disconnect();
      source.silentGain.disconnect();
      await source.context.close().catch(() => {});
      this.onSourceState(source.track, "stopped", "Ready to start");
    }
    this.sources.clear();
    this.onActivityChange(this.active);
    this.sessionOriginMs = 0;
    this.stopping = false;

    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  reportInterruption(track, error) {
    if (this.stopping || this.interruptionReported) return;
    this.interruptionReported = true;
    this.onSourceState(track, "error", describeCaptureError(error, track).message);
    this.onInterruption(track, error);
  }
}

export class CaptureStartCancelled extends Error {
  constructor() {
    super("Audio capture start was cancelled.");
    this.name = "CaptureStartCancelled";
  }
}

export function nextPacketTiming(previousEndMs, sampleCount) {
  if (!Number.isSafeInteger(previousEndMs) || previousEndMs < 0) {
    throw new RangeError("previousEndMs must be a non-negative integer");
  }
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
    throw new RangeError("sampleCount must be a positive integer");
  }
  const durationMs = Math.max(1, Math.round(sampleCount * 1_000 / TRANSCRIPTION_SAMPLE_RATE));
  return { startMs: previousEndMs, endMs: previousEndMs + durationMs };
}

export function sourceStartOffset(sessionOriginMs, attachedAtMs) {
  if (!Number.isFinite(sessionOriginMs) || !Number.isFinite(attachedAtMs)) {
    throw new RangeError("Session clock values must be finite");
  }
  return Math.max(0, Math.round(attachedAtMs - sessionOriginMs));
}

export function describeCaptureError(error, track) {
  if (error instanceof MeetingCaptureError) return error;
  const sourceName = track === "system" ? "Meeting audio" : "The microphone";
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return captureError(track, "permission_denied");
    case "NotFoundError":
    case "DevicesNotFoundError":
      return captureError(track, "source_unavailable");
    case "NotReadableError":
    case "AbortError":
      return new MeetingCaptureError(
        "input_unavailable",
        `${sourceName} could not be opened. Close other apps that are using this input, then try again.`,
        track
      );
    default:
      return new MeetingCaptureError(
        "capture_failed",
        `${sourceName} was interrupted. Check permissions, then start again.`,
        track
      );
  }
}

export class MeetingCaptureError extends Error {
  constructor(code, message, track) {
    super(message);
    this.name = "MeetingCaptureError";
    this.code = code;
    this.track = track;
  }
}

async function requestSystemAudio() {
  if (!navigator.mediaDevices?.getDisplayMedia) throw captureError("system", "source_unavailable");
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  // Chromium requires a video track for getDisplayMedia. It is never observed or stored.
  for (const videoTrack of stream.getVideoTracks()) videoTrack.stop();
  if (stream.getAudioTracks().length === 0) {
    stopMediaStream(stream);
    throw captureError("system", "source_unavailable");
  }
  return stream;
}

async function requestMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) throw captureError("microphone", "source_unavailable");
  return navigator.mediaDevices.getUserMedia({
    video: false,
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
}

function captureError(track, code) {
  const messages = {
    system: {
      permission_denied: "Allow screen and audio capture in system settings, then try again.",
      source_unavailable: "Meeting audio is unavailable. Check the system capture permission.",
      input_interrupted: "Meeting audio was interrupted. Start a new transcription.",
      audio_context_suspended: "Meeting audio processing could not start. Try again."
    },
    microphone: {
      permission_denied: "Allow microphone access in system settings, then try again.",
      source_unavailable: "No available microphone was found.",
      input_interrupted: "The microphone was interrupted. Check the connection, then start again.",
      audio_context_suspended: "Microphone processing could not start. Try again."
    }
  };
  return new MeetingCaptureError(code, messages[track][code], track);
}

function positiveTimeout(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function stopMediaStream(stream) {
  for (const track of stream.getTracks()) track.stop();
}
