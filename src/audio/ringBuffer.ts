/**
 * Fixed-capacity ring buffer of 16 kHz mono PCM samples — the single bounded
 * structure model-input audio flows through between the AudioWorklet
 * (`worklet-processor.js`, producer) and the transcription worker's
 * `ModelEngine.feed()` (U4, consumer). Fundament for R14 (long-run
 * backpressure): capacity is fixed at construction and NEVER grows;
 * writing past capacity overwrites the oldest unread samples instead of
 * allocating more memory, so a slow/backed-up consumer degrades to losing
 * old audio rather than growing without bound over a 4h session.
 *
 * KTD4 (non-negotiable): no `SharedArrayBuffer`, no `Atomics`. The app
 * deliberately ships without COOP/COEP (would break the model download),
 * so `SharedArrayBuffer` isn't available anyway. This is a plain
 * `Float32Array`-backed structure, written on the same thread it's read on
 * (the audio-consuming side of the pipeline) — no cross-thread sharing
 * happens through this object. Getting samples across the worklet/main/
 * worker boundaries happens via ordinary `postMessage` with a
 * `Float32Array`'s `.buffer` passed as a Transferable; `read()` below
 * returns a plain contiguous `Float32Array` whose `.buffer` a caller can
 * transfer directly.
 */
export class RingBuffer {
  private readonly capacity: number;
  private readonly data: Float32Array;
  /** Index of the next slot to be written. */
  private writeIndex = 0;
  /** Index of the oldest unread sample. */
  private readIndex = 0;
  /** Count of currently held, unread samples. Always `<= capacity`. */
  private size = 0;

  constructor(capacityInSamples: number) {
    if (!Number.isInteger(capacityInSamples) || capacityInSamples <= 0) {
      throw new RangeError('capacityInSamples must be a positive integer');
    }
    this.capacity = capacityInSamples;
    this.data = new Float32Array(capacityInSamples);
  }

  /** Number of unread samples currently held (always `<= capacity`). */
  get availableSamples(): number {
    return this.size;
  }

  /**
   * Appends `samples` to the buffer. Once the buffer is full, each further
   * write overwrites the oldest unread sample (advances `readIndex`) rather
   * than growing the backing array — internal size never exceeds
   * `capacity`. If `samples.length > capacity`, only the last `capacity`
   * samples of the input survive, which falls out naturally from the same
   * per-sample overwrite loop.
   */
  write(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.data[this.writeIndex] = samples[i];
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
      if (this.size < this.capacity) {
        this.size++;
      } else {
        // Already full: the slot we just wrote held the oldest sample, so
        // the read cursor must step past it too.
        this.readIndex = (this.readIndex + 1) % this.capacity;
      }
    }
  }

  /**
   * Reads up to `count` oldest unread samples as one new, contiguous
   * `Float32Array` (safe to `.buffer`-transfer), removing them from the
   * buffer. Returns fewer than `count` samples (possibly zero, never
   * throws) if that many aren't available yet — callers must treat a short
   * read as "not enough audio yet", not as an error or end-of-stream.
   */
  read(count: number): Float32Array {
    const n = Math.min(count, this.size);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.data[(this.readIndex + i) % this.capacity];
    }
    this.readIndex = (this.readIndex + n) % this.capacity;
    this.size -= n;
    return out;
  }

  /** Reads and removes every currently available sample. */
  readAvailable(): Float32Array {
    return this.read(this.size);
  }
}
