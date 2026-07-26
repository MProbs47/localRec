/**
 * AudioWorkletProcessor: 16 kHz mono capture with in-worklet resampling.
 *
 * Runs on the browser's dedicated audio-rendering thread and is loaded as
 * its own module, standalone from the rest of the app bundle:
 *
 *   const url = new URL('./worklet-processor.js', import.meta.url);
 *   await audioContext.audioWorklet.addModule(url);
 *   const node = new AudioWorkletNode(audioContext, 'pcm-capture-processor');
 *   node.port.onmessage = (event) => ringBuffer.write(event.data); // Float32Array
 *
 * Wiring the above (creating the `AudioContext`, calling `addModule`,
 * connecting the mic `MediaStreamAudioSourceNode` to this node, piping
 * `node.port` messages into `ringBuffer.ts`) is a later unit's job — see
 * plan U3 "Realitäts-Grenze": `AudioWorkletProcessor`/`registerProcessor`
 * cannot be instantiated in Node/jsdom, so this file's actual audio
 * behavior is a manual browser milestone, not something Vitest exercises.
 *
 * Resample duplication (deliberate, documented per the plan's guidance):
 * `../audio/resample.ts` has the same linear-interpolation resampling math
 * and is the *tested* source of truth (see `resample.test.ts`) — Vitest
 * can't instantiate an `AudioWorkletProcessor` to exercise this file
 * directly. This file inlines the same handful of lines instead of
 * importing that module because cross-module imports from an AudioWorklet
 * module are a separate, less-proven import graph from the main app
 * bundle (module-worklet `import` support and how a bundler's
 * `new URL(...)`-based worklet asset resolves relative imports both vary
 * across engines/tooling versions) — DRY loses to the worklet isolation
 * boundary here (CLAUDE.md: "bei Zweifel die kleinere Lösung" — the
 * smaller/more robust option is a plain, dependency-free duplicate, not a
 * cross-module import whose bundling is unverified for this Vite version).
 * If the resampling math changes, change it in both places.
 *
 * Mono choice: with stereo input this averages all channels together
 * (not "take channel 0"), so a mic that happens to record hot on only one
 * channel isn't silently dropped.
 */

const TARGET_SAMPLE_RATE = 16000;

// VU smoothing time constant (§7: "geglättet über rund 100 ms"). The main
// thread reads the resulting `rms` for the VU-meter; the level must reflect
// the MICROPHONE input, not transcription progress, so it is computed here at
// the audio source, not downstream of the model.
const RMS_SMOOTHING_MS = 100;

// Duplicated from src/worker/segmentation.ts `computeRms` (root-mean-square of
// one PCM buffer). Inlined for the same reason as `resampleLinear` below — an
// AudioWorklet module is a separate, less-proven import graph from the app
// bundle, so a dependency-free duplicate beats a cross-module import here
// (CLAUDE.md: "bei Zweifel die kleinere Lösung"). If the math changes, change
// it in both places. `segmentation.test.ts` is the tested source of truth.
function computeRms(samples) {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / samples.length);
}

// Duplicated from src/audio/resample.ts (see file header) — linear
// interpolation resample from `inputRate` to `TARGET_SAMPLE_RATE`.
function resampleLinear(input, inputRate, outputRate) {
  if (inputRate === outputRate) {
    return input;
  }
  const ratio = inputRate / outputRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const sourcePosition = i * ratio;
    const indexLow = Math.floor(sourcePosition);
    const indexHigh = Math.min(indexLow + 1, input.length - 1);
    const fraction = sourcePosition - indexLow;
    output[i] = input[indexLow] + (input[indexHigh] - input[indexLow]) * fraction;
  }
  return output;
}

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Exponentially-smoothed mic level in [0, 1-ish], seeded silent.
    this.smoothedRms = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || input[0].length === 0) {
      // No mic input connected yet this quantum — keep the node alive and
      // wait for the next one rather than emitting silence or stopping.
      return true;
    }

    // Mono downmix: average all channels (documented choice, see header).
    const frameCount = input[0].length;
    const mono = new Float32Array(frameCount);
    for (let channel = 0; channel < input.length; channel++) {
      const channelData = input[channel];
      for (let i = 0; i < frameCount; i++) {
        mono[i] += channelData[i] / input.length;
      }
    }

    // `sampleRate` is a global provided inside AudioWorkletGlobalScope,
    // fixed for the context's lifetime — this is the mismatch check
    // required by KTD10/the plan's sample-rate risk: never assume 16 kHz
    // just because `new AudioContext({ sampleRate: 16000 })` requested it;
    // the browser/OS can still hand back a different real rate.
    const resampled =
      sampleRate === TARGET_SAMPLE_RATE
        ? mono
        : resampleLinear(mono, sampleRate, TARGET_SAMPLE_RATE);

    // Smooth the mic level (§7) with an exponential moving average whose
    // coefficient is derived from this quantum's real duration, so the ~100ms
    // time constant holds regardless of the context's actual sample rate.
    const quantumSeconds = frameCount / sampleRate;
    const alpha = 1 - Math.exp(-quantumSeconds / (RMS_SMOOTHING_MS / 1000));
    this.smoothedRms += alpha * (computeRms(mono) - this.smoothedRms);

    // One message per quantum carrying both channels: the PCM (transferred,
    // not copied — cheap buffer hand-off, matching KTD4's Transferable
    // transport) and the smoothed VU level (a plain number, copied). The
    // main thread writes `pcm` into the ring buffer and reads `rms` for the
    // VU-meter (see App.tsx).
    this.port.postMessage({ pcm: resampled, rms: this.smoothedRms }, [resampled.buffer]);

    return true; // keep the node alive for the rest of the session
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
