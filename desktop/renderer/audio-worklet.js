import { downmixToMono } from "./lib/audio-pipeline.js";

export const TRANSCRIPTION_CAPTURE_PROCESSOR = "transcription-capture";

const AudioWorkletBase = globalThis.AudioWorkletProcessor ?? class {
  constructor() {
    this.port = { postMessage() {} };
  }
};

/**
 * Capture-only worklet: downmix the input quantum and transfer it to the
 * renderer. Any connected output is explicitly silent to prevent feedback.
 */
export class TranscriptionCaptureProcessor extends AudioWorkletBase {
  process(inputs, outputs) {
    const inputChannels = inputs[0];

    if (inputChannels?.length > 0 && inputChannels[0].length > 0) {
      const mono = downmixToMono(inputChannels);
      this.port.postMessage(
        { type: "audio-block", samples: mono },
        [mono.buffer],
      );
    }

    for (const output of outputs) {
      for (const channel of output) {
        channel.fill(0);
      }
    }

    return true;
  }
}

if (typeof globalThis.registerProcessor === "function") {
  globalThis.registerProcessor(
    TRANSCRIPTION_CAPTURE_PROCESSOR,
    TranscriptionCaptureProcessor,
  );
}

