/**
 * Aggregates a model loader's per-file download progress events into a
 * single monotonically increasing 0..1 fraction across all expected files.
 *
 * Extracted out of the engine rather than inlined there because
 * this aggregation logic is GPU-free and has a second, real caller: the
 * model-management UI's overall progress bar (R19/U11) will need the same
 * "many files -> one fraction" translation. A second caller is what earns
 * this its own module (CLAUDE.md: no abstraction without one).
 *
 * The input type is a local structural subset, not `ProgressInfo` imported
 * from `@huggingface/transformers` — this file stays engine-agnostic and
 * testable without a WebGPU/model-library dependency; the engine is the
 * (small, documented) adapter that narrows transformers.js' actual
 * `ProgressInfo` union down to this shape before calling in.
 *
 * Mirrors the aggregation the reference Space uses:
 * only `status: 'progress'` events for `.onnx_data` shards count — the tiny
 * `.json`/tokenizer files complete near-instantly and would otherwise make
 * the overall fraction visibly jump around. Each qualifying file
 * contributes `loaded/total` (0..1); the sum is divided by the expected
 * file count.
 */
export interface ModelFileProgressEvent {
  status: string;
  file: string;
  loaded: number;
  total: number;
}

export type ProgressListener = (fraction: number) => void;

/**
 * Returns a stateful reporter function: feed it raw per-file progress
 * events (in any order, possibly with retried/decreasing values for the
 * same file), and it calls `onProgress` with a 0..1 fraction that never
 * decreases across calls.
 */
export function createProgressAggregator(
  expectedFileCount: number,
  onProgress: ProgressListener,
  /**
   * Which files count toward the aggregate. Defaults to the sharded layout
   * (`*.onnx_data` weight shards). Whisper's q4f16 set stores its weights in
   * plain `*.onnx` files (only the unused fp32 encoder has an `.onnx_data`
   * companion), so `whisperEngine.ts` passes its own matcher — without this
   * the bar would sit at 0 for the entire download even though the model is
   * loading fine. The tiny `.json`/tokenizer files never match either
   * matcher (they'd complete near-instantly and make the fraction jump).
   */
  matchesFile: (file: string) => boolean = (file) => file.endsWith('.onnx_data'),
): (event: ModelFileProgressEvent) => void {
  const perFileFraction = new Map<string, number>();
  let highWaterMark = 0;

  return (event) => {
    if (event.status !== 'progress' || !matchesFile(event.file) || event.total === 0) {
      return;
    }

    const fraction = event.loaded / event.total;
    const previous = perFileFraction.get(event.file) ?? 0;
    // Clamp per file: an out-of-order or retried event must never move
    // that file's own contribution backwards.
    perFileFraction.set(event.file, Math.max(previous, fraction));

    const summed = Array.from(perFileFraction.values()).reduce((sum, value) => sum + value, 0);
    const overall = Math.min(summed / expectedFileCount, 1);

    // Belt-and-braces: the per-file clamping above already makes this sum
    // monotonic, but tracking an explicit high-water mark makes the "never
    // decreases" guarantee hold even if that clamping logic changes later.
    highWaterMark = Math.max(highWaterMark, overall);
    onProgress(highWaterMark);
  };
}
