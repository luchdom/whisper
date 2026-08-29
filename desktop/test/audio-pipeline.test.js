import assert from "node:assert/strict";
import test from "node:test";

import {
  StreamingAudioPipeline,
  StreamingLinearResampler,
  downmixToMono,
  encodePcm16Le,
  float32ToInt16,
} from "../renderer/lib/audio-pipeline.js";

function joinFloat32(blocks) {
  const length = blocks.reduce((total, block) => total + block.length, 0);
  const joined = new Float32Array(length);
  let offset = 0;

  for (const block of blocks) {
    joined.set(block, offset);
    offset += block.length;
  }

  return joined;
}

function resampleInBlocks(signal, blockSizes) {
  const resampler = new StreamingLinearResampler({
    sourceSampleRate: 44_100,
    targetSampleRate: 16_000,
  });
  const output = [];
  let offset = 0;
  let blockIndex = 0;

  while (offset < signal.length) {
    const size = blockSizes[blockIndex % blockSizes.length];
    output.push(resampler.push(signal.subarray(offset, offset + size)));
    offset += size;
    blockIndex += 1;
  }

  output.push(resampler.flush());
  return joinFloat32(output);
}

test("streaming resampling is deterministic across arbitrary block boundaries", () => {
  const signal = Float32Array.from(
    { length: 997 },
    (_, index) => Math.sin(index * 0.071) * 0.75 + Math.cos(index * 0.013) * 0.1,
  );

  const whole = resampleInBlocks(signal, [signal.length]);
  const split = resampleInBlocks(signal, [1, 7, 31, 2, 128, 5, 64]);
  const repeated = resampleInBlocks(signal, [1, 7, 31, 2, 128, 5, 64]);

  assert.deepEqual(split, whole);
  assert.deepEqual(repeated, split);
  assert.equal(whole.length, Math.ceil(signal.length * 16_000 / 44_100));
});

test("downmixing averages channels and PCM conversion clips to int16", () => {
  const mono = downmixToMono([
    Float32Array.of(1, -1, 2, -2, 0.5),
    Float32Array.of(-1, 1, 2, -2, -0.5),
  ]);

  assert.deepEqual(mono, Float32Array.of(0, 0, 2, -2, 0));
  assert.deepEqual(
    float32ToInt16(Float32Array.of(-2, -1, -0.5, 0, 0.5, 1, 2, Number.NaN)),
    Int16Array.of(-32_768, -32_768, -16_384, 0, 16_384, 32_767, 32_767, 0),
  );
  assert.deepEqual(
    encodePcm16Le(Float32Array.of(-1, 0, 1)),
    Uint8Array.of(0x00, 0x80, 0x00, 0x00, 0xff, 0x7f),
  );
});

test("packets are bounded and carry contiguous sample-count timing", () => {
  const pipeline = new StreamingAudioPipeline({
    sourceSampleRate: 16_000,
    chunkSamples: 4,
  });

  const firstPackets = pipeline.push(Float32Array.from({ length: 10 }, (_, index) => index / 10));
  const finalPackets = pipeline.flush();
  const packets = [...firstPackets, ...finalPackets];

  assert.deepEqual(packets.map((packet) => packet.sampleCount), [4, 4, 2]);
  assert.ok(packets.every((packet) => packet.sampleCount <= 4));
  assert.ok(packets.every((packet) => packet.pcm.byteLength === packet.sampleCount * 2));
  assert.deepEqual(
    packets.map(({ startSample, endSample, start_ms, end_ms }) => ({
      startSample,
      endSample,
      start_ms,
      end_ms,
    })),
    [
      { startSample: 0, endSample: 4, start_ms: 0, end_ms: 0.25 },
      { startSample: 4, endSample: 8, start_ms: 0.25, end_ms: 0.5 },
      { startSample: 8, endSample: 10, start_ms: 0.5, end_ms: 0.625 },
    ],
  );

  for (let index = 1; index < packets.length; index += 1) {
    assert.equal(packets[index].startSample, packets[index - 1].endSample);
    assert.equal(packets[index].start_ms, packets[index - 1].end_ms);
    assert.ok(packets[index].end_ms > packets[index].start_ms);
  }
});

test("audio worklet posts mono blocks and never writes captured audio to output", async () => {
  const registrations = [];
  const posted = [];
  const previousBase = globalThis.AudioWorkletProcessor;
  const previousRegister = globalThis.registerProcessor;

  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = {
        postMessage(message) {
          posted.push(message);
        },
      };
    }
  };
  globalThis.registerProcessor = (name, Processor) => {
    registrations.push({ name, Processor });
  };

  try {
    const workletUrl = new URL("../renderer/audio-worklet.js", import.meta.url);
    workletUrl.searchParams.set("test", String(Date.now()));
    const { TranscriptionCaptureProcessor } = await import(workletUrl.href);
    const processor = new TranscriptionCaptureProcessor();
    const output = [[Float32Array.of(0.5, 0.5, 0.5)]];

    assert.equal(processor.process([
      [Float32Array.of(1, 0, -1), Float32Array.of(-1, 1, 1)],
    ], output), true);

    assert.equal(registrations[0].name, "transcription-capture");
    assert.deepEqual(posted[0].samples, Float32Array.of(0, 0.5, 0));
    assert.deepEqual(output[0][0], Float32Array.of(0, 0, 0));
  } finally {
    if (previousBase === undefined) {
      delete globalThis.AudioWorkletProcessor;
    } else {
      globalThis.AudioWorkletProcessor = previousBase;
    }
    if (previousRegister === undefined) {
      delete globalThis.registerProcessor;
    } else {
      globalThis.registerProcessor = previousRegister;
    }
  }
});

