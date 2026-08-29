/**
 * Pure, streaming audio conversion helpers shared by the renderer and tests.
 *
 * AudioPipeline accepts Web Audio-style channel blocks, downmixes them to mono,
 * resamples them to 16 kHz, and emits bounded PCM signed 16-bit little-endian
 * packets. It deliberately does not depend on Electron, the DOM, or Node APIs.
 */

export const TRANSCRIPTION_SAMPLE_RATE = 16_000;
export const DEFAULT_PACKET_SAMPLES = 3_200;

function assertPositiveFinite(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function isSampleArray(value) {
  return Array.isArray(value) || (
    ArrayBuffer.isView(value) && !(value instanceof DataView)
  );
}

/**
 * Downmix a mono sample array or an array of channel sample arrays to mono.
 * Channels are averaged frame-by-frame so adding channels does not add gain.
 */
export function downmixToMono(input) {
  if (input == null) {
    throw new TypeError("audio input is required");
  }

  if (ArrayBuffer.isView(input) && !(input instanceof DataView)) {
    return Float32Array.from(input);
  }

  if (!Array.isArray(input)) {
    throw new TypeError("audio input must be a sample array or an array of channels");
  }

  if (input.length === 0) {
    return new Float32Array(0);
  }

  if (typeof input[0] === "number") {
    return Float32Array.from(input);
  }

  const channels = input;
  if (!channels.every(isSampleArray)) {
    throw new TypeError("every audio channel must be a sample array");
  }

  const frameCount = channels[0].length;
  if (!channels.every((channel) => channel.length === frameCount)) {
    throw new RangeError("all audio channels must contain the same number of frames");
  }

  const mono = new Float32Array(frameCount);
  const gain = 1 / channels.length;

  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels.length; channel += 1) {
      sum += channels[channel][frame];
    }
    mono[frame] = sum * gain;
  }

  return mono;
}

/** Convert normalized floating-point audio to signed 16-bit samples. */
export function float32ToInt16(samples) {
  if (!isSampleArray(samples)) {
    throw new TypeError("samples must be an array-like collection");
  }

  const result = new Int16Array(samples.length);

  for (let index = 0; index < samples.length; index += 1) {
    const finiteSample = Number.isFinite(samples[index]) ? samples[index] : 0;
    const clamped = Math.max(-1, Math.min(1, finiteSample));
    result[index] = Math.round(clamped * (clamped < 0 ? 32_768 : 32_767));
  }

  return result;
}

/** Encode normalized floating-point audio as explicit little-endian PCM bytes. */
export function encodePcm16Le(samples) {
  const int16 = float32ToInt16(samples);
  const bytes = new Uint8Array(int16.length * Int16Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < int16.length; index += 1) {
    view.setInt16(index * Int16Array.BYTES_PER_ELEMENT, int16[index], true);
  }

  return bytes;
}

function canonicalSourcePosition(outputIndex, sourceSampleRate, targetSampleRate) {
  const position = outputIndex * sourceSampleRate / targetSampleRate;
  const nearestInteger = Math.round(position);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(position)) * 4;

  return Math.abs(position - nearestInteger) <= tolerance
    ? nearestInteger
    : position;
}

/**
 * Stateful linear resampler whose output is independent of input block splits.
 * The next output index is retained across push() calls, which preserves the
 * fractional source position at every Web Audio render-quantum boundary.
 */
export class StreamingLinearResampler {
  constructor({ sourceSampleRate, targetSampleRate = TRANSCRIPTION_SAMPLE_RATE }) {
    assertPositiveFinite(sourceSampleRate, "sourceSampleRate");
    assertPositiveFinite(targetSampleRate, "targetSampleRate");

    this.sourceSampleRate = sourceSampleRate;
    this.targetSampleRate = targetSampleRate;

    this._buffer = new Float32Array(0);
    this._bufferStart = 0;
    this._sourceSamplesSeen = 0;
    this._nextOutputIndex = 0;
    this._ended = false;
  }

  get sourceSamplesSeen() {
    return this._sourceSamplesSeen;
  }

  get outputSamplesProduced() {
    return this._nextOutputIndex;
  }

  push(monoSamples) {
    if (this._ended) {
      throw new Error("cannot push audio after the resampler has been flushed");
    }
    if (!isSampleArray(monoSamples)) {
      throw new TypeError("monoSamples must be an array-like collection");
    }
    if (monoSamples.length === 0) {
      return new Float32Array(0);
    }

    this._append(monoSamples);
    return this._drain(false);
  }

  /**
   * Finish the stream. A final fractional sample uses last-sample hold so the
   * output duration represents every received source frame.
   */
  flush() {
    if (this._ended) {
      return new Float32Array(0);
    }

    this._ended = true;
    return this._drain(true);
  }

  _append(samples) {
    const incoming = Float32Array.from(samples);
    const combined = new Float32Array(this._buffer.length + incoming.length);
    combined.set(this._buffer);
    combined.set(incoming, this._buffer.length);

    this._buffer = combined;
    this._sourceSamplesSeen += incoming.length;
  }

  _drain(allowEndPadding) {
    const output = [];

    while (this._sourceSamplesSeen > 0) {
      const position = canonicalSourcePosition(
        this._nextOutputIndex,
        this.sourceSampleRate,
        this.targetSampleRate,
      );

      // Output sample timestamps cover the half-open source duration [0, N).
      if (position >= this._sourceSamplesSeen) {
        break;
      }

      const leftIndex = Math.floor(position);
      const fraction = position - leftIndex;
      const rightIndex = leftIndex + 1;
      const hasRightSample = rightIndex < this._sourceSamplesSeen;

      if (fraction !== 0 && !hasRightSample && !allowEndPadding) {
        break;
      }

      const left = this._sampleAt(leftIndex);
      const right = hasRightSample ? this._sampleAt(rightIndex) : left;
      output.push(left + (right - left) * fraction);
      this._nextOutputIndex += 1;
    }

    this._discardConsumedPrefix();
    return Float32Array.from(output);
  }

  _sampleAt(absoluteIndex) {
    const localIndex = absoluteIndex - this._bufferStart;
    if (localIndex < 0 || localIndex >= this._buffer.length) {
      throw new RangeError(`source sample ${absoluteIndex} is outside the retained window`);
    }
    return this._buffer[localIndex];
  }

  _discardConsumedPrefix() {
    const nextPosition = canonicalSourcePosition(
      this._nextOutputIndex,
      this.sourceSampleRate,
      this.targetSampleRate,
    );
    const keepFrom = Math.min(Math.floor(nextPosition), this._sourceSamplesSeen);
    const discardCount = keepFrom - this._bufferStart;

    if (discardCount <= 0) {
      return;
    }

    this._buffer = this._buffer.slice(discardCount);
    this._bufferStart = keepFrom;
  }
}

/**
 * Complete Web Audio -> mono 16 kHz PCM packet pipeline.
 * Packet endSample/end_ms are exclusive, so adjacent packet timings touch.
 */
export class StreamingAudioPipeline {
  constructor({
    sourceSampleRate,
    targetSampleRate = TRANSCRIPTION_SAMPLE_RATE,
    chunkSamples = DEFAULT_PACKET_SAMPLES,
  }) {
    assertPositiveInteger(chunkSamples, "chunkSamples");

    this.sourceSampleRate = sourceSampleRate;
    this.targetSampleRate = targetSampleRate;
    this.chunkSamples = chunkSamples;
    this._resampler = new StreamingLinearResampler({
      sourceSampleRate,
      targetSampleRate,
    });
    this._pending = [];
    this._nextPacketSample = 0;
    this._ended = false;
  }

  get pendingSampleCount() {
    return this._pending.length;
  }

  get outputSampleCount() {
    return this._nextPacketSample + this._pending.length;
  }

  push(input) {
    if (this._ended) {
      throw new Error("cannot push audio after the pipeline has been flushed");
    }

    const mono = downmixToMono(input);
    this._enqueue(this._resampler.push(mono));
    return this._takePackets(false);
  }

  flush() {
    if (this._ended) {
      return [];
    }

    this._ended = true;
    this._enqueue(this._resampler.flush());
    return this._takePackets(true);
  }

  _enqueue(samples) {
    for (let index = 0; index < samples.length; index += 1) {
      this._pending.push(samples[index]);
    }
  }

  _takePackets(includePartial) {
    const packets = [];

    while (
      this._pending.length >= this.chunkSamples ||
      (includePartial && this._pending.length > 0)
    ) {
      const sampleCount = Math.min(this.chunkSamples, this._pending.length);
      const samples = Float32Array.from(this._pending.splice(0, sampleCount));
      packets.push(this._createPacket(samples));
    }

    return packets;
  }

  _createPacket(samples) {
    const startSample = this._nextPacketSample;
    const endSample = startSample + samples.length;
    this._nextPacketSample = endSample;

    return {
      format: "pcm_s16le",
      sampleRate: this.targetSampleRate,
      channelCount: 1,
      sampleCount: samples.length,
      startSample,
      endSample,
      start_ms: startSample * 1_000 / this.targetSampleRate,
      end_ms: endSample * 1_000 / this.targetSampleRate,
      pcm: encodePcm16Le(samples),
    };
  }
}

