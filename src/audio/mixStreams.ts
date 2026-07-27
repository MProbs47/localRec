/**
 * Plan 003 (Online Meeting mode), U2 — KTD-M2: pure graph-wiring for the
 * "Online Meeting" mode. Mic and system-audio (`systemAudio.ts`, U1) are two
 * `MediaStream`s that need to reach the *same* two downstream consumers the
 * existing single-mic path already has — the transcription/VU
 * `AudioWorkletNode` and the `MediaStreamAudioDestinationNode` whose
 * `.stream` feeds `startOpusRecorder` (`recorder.ts`) for the `.webm`. Web
 * Audio sums multiple inputs into a node automatically, so both sources
 * simply `connect()` to both targets — no mixing/gain node, no resampling,
 * no second transcription or recording path (DRY: this function only swaps
 * what feeds the *existing* graph, never duplicates it).
 *
 * A missing `system` stream (mic-only recording, or `canCaptureSystemAudio()`
 * says no) degrades gracefully to just the mic being wired — never throws.
 *
 * Narrow structural interfaces, not the ambient DOM `AudioContext`/`AudioNode`
 * types, for the same Node/Vitest-testability reason as `recorder.ts`/
 * `fileSink.ts` (see those files' headers): this module is pure wiring logic
 * with no real Web Audio available under Vitest, so a fake `AudioContextLike`
 * exercises the exact connect/disconnect calls this function makes.
 */

export interface AudioNodeLike {
  connect(node: AudioNodeLike): void;
}

export interface MediaStreamAudioSourceNodeLike extends AudioNodeLike {
  disconnect(): void;
}

export interface MediaStreamAudioDestinationNodeLike extends AudioNodeLike {
  readonly stream: MediaStream;
}

export interface AudioContextLike {
  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNodeLike;
  createMediaStreamDestination(): MediaStreamAudioDestinationNodeLike;
}

export interface MixStreamsInput {
  mic: MediaStream;
  /** Absent/null when system-audio capture wasn't used (mic-only) — wired gracefully without it. */
  system?: MediaStream | null;
}

/**
 * An extra node that receives the **mic alone** (owner feedback 2026-07-27).
 * The worklet's RMS — and with it the VU meter — sees the SUM of both
 * sources, so during a meeting a dead microphone is drowned out by the
 * remote side: the meter keeps moving, and you only notice afterwards that
 * your own voice is missing (a Bluetooth headset that silently stayed in its
 * playback-only mode is enough to cause it). A monitor tapped off the mic
 * branch before the sum is the only place that difference is visible.
 * Optional — Local Recording has nothing to disambiguate (one source, the
 * meter IS the mic) and passes nothing.
 */
export type MicMonitorNode = AudioNodeLike;

export interface ConnectedMixedSources {
  /** The stream `startOpusRecorder` should record — the destination node's `.stream`. */
  recordStream: MediaStream;
  /** Disconnects every source node this call created. Idempotent-safe to call once at teardown. */
  teardown: () => void;
}

/**
 * Wires `streams.mic` (and `streams.system`, if present) into `ctx`: both
 * sources connect to `workletNode` (transcription/VU, unchanged pipeline)
 * and to a fresh `MediaStreamAudioDestinationNode` (recording). Returns that
 * destination's `.stream` plus a `teardown` that disconnects the created
 * source nodes — the destination/worklet/monitor nodes themselves are owned
 * by the caller and outlive this call.
 *
 * `micMonitor` (optional) additionally receives the mic source alone — see
 * `MicMonitorNode` for why that tap has to sit before the sum.
 */
export function connectMixedSources(
  ctx: AudioContextLike,
  streams: MixStreamsInput,
  workletNode: AudioNodeLike,
  micMonitor?: MicMonitorNode,
): ConnectedMixedSources {
  const dest = ctx.createMediaStreamDestination();
  const sources: MediaStreamAudioSourceNodeLike[] = [];

  const wire = (stream: MediaStream, extra?: AudioNodeLike) => {
    const source = ctx.createMediaStreamSource(stream);
    source.connect(workletNode);
    source.connect(dest);
    // The mic monitor hangs off the mic source only, BEFORE anything is
    // summed — that is the whole point (see `MicMonitorNode`). It is a pure
    // tap: nothing is routed onward from it, so it can neither colour the
    // recording nor the transcription feed.
    if (extra) source.connect(extra);
    sources.push(source);
  };

  wire(streams.mic, micMonitor);
  if (streams.system) {
    wire(streams.system);
  }

  return {
    recordStream: dest.stream,
    teardown: () => {
      for (const source of sources) {
        source.disconnect();
      }
    },
  };
}
