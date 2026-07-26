// Realitätsgrenze: `AudioContext`/`AudioWorkletNode`/`MediaStreamAudioSourceNode`
// don't exist in Node/Vitest — every fake below implements exactly the
// narrow structural interface `mixStreams.ts` depends on (`AudioContextLike`,
// `MediaStreamAudioSourceNodeLike`), so the graph-wiring logic under test
// (which sources connect to which nodes, and what teardown disconnects)
// runs for real against these fakes. A real Web-Audio graph stays the plan's
// documented manual milestone.
import { describe, expect, it } from 'vitest';
import {
  connectMixedSources,
  type AudioContextLike,
  type AudioNodeLike,
  type MediaStreamAudioDestinationNodeLike,
  type MediaStreamAudioSourceNodeLike,
} from './mixStreams';

class FakeSourceNode implements MediaStreamAudioSourceNodeLike {
  readonly sourceStream: MediaStream;
  connectedTo: AudioNodeLike[] = [];
  disconnected = false;

  constructor(sourceStream: MediaStream) {
    this.sourceStream = sourceStream;
  }

  connect(node: AudioNodeLike): void {
    this.connectedTo.push(node);
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeDestinationNode implements MediaStreamAudioDestinationNodeLike {
  readonly stream: MediaStream;
  connectedTo: AudioNodeLike[] = [];

  constructor(stream: MediaStream) {
    this.stream = stream;
  }

  connect(node: AudioNodeLike): void {
    this.connectedTo.push(node);
  }
}

class FakeAudioContext implements AudioContextLike {
  createdSources: FakeSourceNode[] = [];
  destinationStream = { id: 'dest-stream' } as unknown as MediaStream;
  lastDest: FakeDestinationNode | null = null;

  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNodeLike {
    const node = new FakeSourceNode(stream);
    this.createdSources.push(node);
    return node;
  }

  createMediaStreamDestination(): MediaStreamAudioDestinationNodeLike {
    this.lastDest = new FakeDestinationNode(this.destinationStream);
    return this.lastDest;
  }
}

const fakeWorkletNode = { id: 'worklet' } as unknown as AudioNodeLike;
const micStream = { id: 'mic' } as unknown as MediaStream;
const systemStream = { id: 'system' } as unknown as MediaStream;

describe('connectMixedSources (KTD-M2: mic + system → worklet AND recorder destination, one stream downstream)', () => {
  it('connects both mic and system sources to the worklet node and the destination node', () => {
    const ctx = new FakeAudioContext();

    connectMixedSources(ctx, { mic: micStream, system: systemStream }, fakeWorkletNode);

    expect(ctx.createdSources).toHaveLength(2);
    const [micSrc, sysSrc] = ctx.createdSources;
    expect(micSrc.sourceStream).toBe(micStream);
    expect(sysSrc.sourceStream).toBe(systemStream);

    expect(micSrc.connectedTo).toHaveLength(2);
    expect(sysSrc.connectedTo).toHaveLength(2);
    expect(micSrc.connectedTo).toContain(fakeWorkletNode);
    expect(sysSrc.connectedTo).toContain(fakeWorkletNode);
    expect(micSrc.connectedTo).toContain(ctx.lastDest);
    expect(sysSrc.connectedTo).toContain(ctx.lastDest);
  });

  it('returns recordStream as exactly the destination node\'s .stream', () => {
    const ctx = new FakeAudioContext();

    const { recordStream } = connectMixedSources(ctx, { mic: micStream, system: systemStream }, fakeWorkletNode);

    expect(recordStream).toBe(ctx.destinationStream);
  });

  it('teardown disconnects both mic and system sources', () => {
    const ctx = new FakeAudioContext();

    const { teardown } = connectMixedSources(ctx, { mic: micStream, system: systemStream }, fakeWorkletNode);
    teardown();

    expect(ctx.createdSources.every((src) => src.disconnected)).toBe(true);
  });

  it('wires only the mic when no system stream is given, without throwing', () => {
    const ctx = new FakeAudioContext();

    const { recordStream, teardown } = connectMixedSources(ctx, { mic: micStream, system: null }, fakeWorkletNode);

    expect(ctx.createdSources).toHaveLength(1);
    expect(ctx.createdSources[0].sourceStream).toBe(micStream);
    expect(ctx.createdSources[0].connectedTo).toHaveLength(2);
    expect(recordStream).toBe(ctx.destinationStream);

    expect(() => teardown()).not.toThrow();
    expect(ctx.createdSources[0].disconnected).toBe(true);
  });

  it('wires only the mic when system is omitted entirely', () => {
    const ctx = new FakeAudioContext();

    connectMixedSources(ctx, { mic: micStream }, fakeWorkletNode);

    expect(ctx.createdSources).toHaveLength(1);
  });
});
