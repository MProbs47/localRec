import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ringBuffer';

describe('RingBuffer (bounded model-input audio buffer, R14)', () => {
  it('never exceeds its fixed capacity and overwrites the oldest samples once full', () => {
    const buffer = new RingBuffer(3);
    buffer.write(new Float32Array([1, 2, 3, 4, 5]));

    expect(buffer.availableSamples).toBe(3);
    expect(Array.from(buffer.read(3))).toEqual([3, 4, 5]);
    expect(buffer.availableSamples).toBe(0);
  });

  it('never grows internal size beyond capacity across many small writes', () => {
    const buffer = new RingBuffer(10);
    for (let i = 0; i < 50; i++) {
      buffer.write(new Float32Array([i]));
      expect(buffer.availableSamples).toBeLessThanOrEqual(10);
    }
    expect(buffer.availableSamples).toBe(10);
    // Only the last 10 written values (40..49) should survive.
    expect(Array.from(buffer.readAvailable())).toEqual([40, 41, 42, 43, 44, 45, 46, 47, 48, 49]);
  });

  it('a single write longer than capacity keeps only the trailing `capacity` samples', () => {
    const buffer = new RingBuffer(4);
    buffer.write(new Float32Array([1, 2, 3, 4, 5, 6, 7]));

    expect(buffer.availableSamples).toBe(4);
    expect(Array.from(buffer.read(4))).toEqual([4, 5, 6, 7]);
  });

  it('returns fewer samples than requested (never throws) when not enough data is available', () => {
    const buffer = new RingBuffer(8);
    buffer.write(new Float32Array([1, 2]));

    const out = buffer.read(5);
    expect(Array.from(out)).toEqual([1, 2]);
    expect(buffer.availableSamples).toBe(0);
  });

  it('delivers contiguous, correctly ordered samples across a write/read cycle that wraps the buffer', () => {
    const buffer = new RingBuffer(4);
    buffer.write(new Float32Array([1, 2, 3]));
    expect(Array.from(buffer.read(2))).toEqual([1, 2]); // readIndex now at 2, one sample (3) left

    // This write starts at writeIndex=3 and wraps past index 0 -> the wrap
    // boundary is exercised right here.
    buffer.write(new Float32Array([4, 5, 6]));

    expect(buffer.availableSamples).toBe(4);
    expect(Array.from(buffer.readAvailable())).toEqual([3, 4, 5, 6]);
  });

  it('repeated wrap-spanning write/read cycles stay contiguous and in order (long-run soak)', () => {
    // Capacity comfortably exceeds one round's write, and each round drains
    // exactly what it wrote (net-zero growth) — no overwrite ever happens
    // here, so this isolates the "does the wrap-around index math stay
    // correct forever" question from the (separately tested) overwrite
    // behavior.
    const buffer = new RingBuffer(5);
    const consumed: number[] = [];
    let nextValue = 0;

    for (let round = 0; round < 20; round++) {
      const chunk = new Float32Array([nextValue, nextValue + 1, nextValue + 2]);
      nextValue += 3;
      buffer.write(chunk);

      expect(buffer.availableSamples).toBeLessThanOrEqual(5);
      consumed.push(...buffer.readAvailable());
    }

    expect(buffer.availableSamples).toBe(0);
    expect(consumed).toHaveLength(60);
    // Every consumed value must be a contiguous, monotonically increasing
    // run (never reordered, never duplicated, nothing dropped — since
    // capacity was never exceeded).
    for (let i = 1; i < consumed.length; i++) {
      expect(consumed[i]).toBe(consumed[i - 1] + 1);
    }
    expect(consumed[0]).toBe(0);
    expect(consumed.at(-1)).toBe(59);
  });

  it('rejects a non-positive or non-integer capacity', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new RingBuffer(-1)).toThrow(RangeError);
    expect(() => new RingBuffer(1.5)).toThrow(RangeError);
  });
});
