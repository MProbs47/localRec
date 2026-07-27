/**
 * Plan 003 (Online Meeting mode), U1 — KTD-M1/KTD-M3: system-/meeting-audio
 * capture via `getDisplayMedia`, and the feature-detection that gates
 * offering the "Online Meeting" mode at all.
 *
 * `getDisplayMedia` is the browser's only mechanism for system-/tab-audio,
 * and Chromium only hands out audio alongside a chosen video surface
 * (KTD-M1) — so `captureSystemAudio` always requests `{audio:true,
 * video:true}`, then immediately `stop()`s and `removeTrack()`s every video
 * track before returning. Nothing video-shaped is ever kept, decoded, or
 * rendered; only the audio track survives, which then joins the mic in
 * `mixStreams.ts` (U2).
 *
 * Two user-facing failure modes need to be told apart from a generic throw,
 * because the caller (U4) reacts to each differently:
 * - the user cancelling the screen/window picker (`NotAllowedError` or
 *   `AbortError` from `getDisplayMedia`) is a normal "changed their mind",
 *   not an error screen;
 * - forgetting the "Share system/tab audio" checkbox in the picker (the most
 *   common mistake, per the plan) yields a stream with zero audio tracks —
 *   worth a clear retry hint, not a stack trace.
 * `SystemAudioError#reason` discriminates the two (plus any other failure,
 * which keeps its own `Error` shape) so `catch` blocks upstream can branch
 * without string-matching messages.
 *
 * Same DI shape as `recorder.ts`'s `getMediaRecorderCtor`: narrow structural
 * types (`MediaStreamLike`, `MediaStreamTrackLike`) stand in for the real DOM
 * types so this file is unit-testable under Node/Vitest (no real
 * `getDisplayMedia` there), and the default dependency reaches the real
 * `navigator.mediaDevices` through an injectable env rather than naming the
 * ambient DOM identifier directly.
 */

export interface MediaStreamTrackLike {
  stop(): void;
}

export interface MediaStreamLike {
  getVideoTracks(): MediaStreamTrackLike[];
  getAudioTracks(): MediaStreamTrackLike[];
  removeTrack(track: MediaStreamTrackLike): void;
}

/**
 * What `captureSystemAudio` asks the picker for. Only `audio`/`video` are
 * load-bearing (KTD-M1: Chromium hands out audio only alongside a video
 * surface); the rest are **hints** that shorten the dialog — the browser may
 * ignore any of them, which is why nothing downstream depends on them.
 */
export interface DisplayMediaConstraintsLike {
  audio: boolean;
  video: boolean | { displaySurface?: 'monitor' | 'window' | 'browser' };
  systemAudio?: 'include' | 'exclude';
  selfBrowserSurface?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
}

export interface MediaDevicesLike {
  getDisplayMedia(constraints: DisplayMediaConstraintsLike): Promise<MediaStreamLike>;
}

export interface SystemAudioDeps {
  /** Defaults to the real `navigator.mediaDevices`, reached via `getGlobalMediaDevices()`. */
  mediaDevices?: MediaDevicesLike;
}

/** Why `captureSystemAudio` failed, distinct enough for callers to branch on without matching message strings. */
export type SystemAudioErrorReason = 'no-audio-track' | 'aborted' | 'failed';

export class SystemAudioError extends Error {
  readonly reason: SystemAudioErrorReason;

  constructor(reason: SystemAudioErrorReason, message?: string) {
    super(message ?? reason);
    this.name = 'SystemAudioError';
    this.reason = reason;
  }
}

/**
 * The one request this module makes — a named constant so the test can nail
 * it down (owner feedback 2026-07-27: "je weniger Schritte der User machen
 * muss").
 *
 * `audio: true` + a video surface is the load-bearing part (KTD-M1). The
 * other three only pre-sort the dialog, and each is a *wish* the browser may
 * ignore — capture works exactly as before if it does:
 * - `video: { displaySurface: 'monitor' }` opens the picker on «Gesamter
 *   Bildschirm» instead of Chrome's own default tab. That is the pane that
 *   matters here: a Teams/Zoom **desktop app** is only audible via system
 *   audio; sharing a browser tab would capture that tab, not the call.
 * - `systemAudio: 'include'` asks for the system-audio option to be offered
 *   at all (already Chrome's default; stated so a future default change
 *   can't quietly take the checkbox away).
 * - `selfBrowserSurface: 'exclude'` drops this app's own tab from the list —
 *   picking it would record silence and is never what anyone wants.
 * - `surfaceSwitching: 'exclude'` hides "share a different surface" mid-run:
 *   swapping the source under a running recording has no meaning here.
 *
 * **What is NOT possible, so nobody looks for it again:** the site cannot
 * pre-tick "Systemaudio freigeben". There is no such API — Chrome alone owns
 * that checkbox (and starts it unchecked for a screen, checked for a tab),
 * because a page that could turn on audio capture by itself would be a
 * wiretap. The picker itself is likewise unskippable: every call needs a
 * fresh user gesture and shows the dialog, with no persistent grant. That
 * makes the forgotten checkbox a permanent failure mode, which is exactly
 * why `'no-audio-track'` below stays a first-class, explained outcome
 * instead of a generic error.
 */
export const DISPLAY_MEDIA_CONSTRAINTS: DisplayMediaConstraintsLike = {
  audio: true,
  video: { displaySurface: 'monitor' },
  systemAudio: 'include',
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'exclude',
};

/** `getDisplayMedia` error names that mean "the user cancelled the picker" — not a real failure (KTD-M1). */
const ABORT_ERROR_NAMES = new Set(['NotAllowedError', 'AbortError']);

function errorName(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'name' in error ? (error as { name?: unknown }).name as string : undefined;
}

function getGlobalMediaDevices(): MediaDevicesLike | undefined {
  return (globalThis as unknown as { navigator?: { mediaDevices?: MediaDevicesLike } }).navigator?.mediaDevices;
}

/**
 * Requests system-/meeting-audio (Teams/Zoom desktop share) and returns an
 * audio-only `MediaStream`. Always asks with `DISPLAY_MEDIA_CONSTRAINTS`
 * (audio + a video surface is the Chromium requirement, KTD-M1; the rest
 * only pre-sorts the picker), then discards the video side immediately.
 *
 * Throws `SystemAudioError('aborted', …)` if the user cancels the picker,
 * `SystemAudioError('no-audio-track', …)` if they forgot the system-audio
 * checkbox, or re-throws (wrapped as `SystemAudioError('failed', …)`) any
 * other `getDisplayMedia` failure — always distinguishable from the first two.
 */
export async function captureSystemAudio(deps: SystemAudioDeps = {}): Promise<MediaStream> {
  const mediaDevices = deps.mediaDevices ?? getGlobalMediaDevices();
  if (!mediaDevices) {
    throw new SystemAudioError('failed', 'getDisplayMedia ist in dieser Umgebung nicht verfügbar');
  }

  let stream: MediaStreamLike;
  try {
    stream = await mediaDevices.getDisplayMedia(DISPLAY_MEDIA_CONSTRAINTS);
  } catch (error) {
    const name = errorName(error);
    if (name && ABORT_ERROR_NAMES.has(name)) {
      throw new SystemAudioError('aborted', 'Systemaudio-Auswahl abgebrochen');
    }
    throw new SystemAudioError('failed', error instanceof Error ? error.message : 'getDisplayMedia fehlgeschlagen');
  }

  for (const track of stream.getVideoTracks()) {
    track.stop();
    stream.removeTrack(track);
  }

  if (stream.getAudioTracks().length === 0) {
    throw new SystemAudioError(
      'no-audio-track',
      'Systemaudio nicht aktiviert — bitte beim Teilen das Häkchen „Audio freigeben" setzen',
    );
  }

  return stream as unknown as MediaStream;
}

export interface SystemAudioEnvLike {
  navigator?: {
    mediaDevices?: Partial<MediaDevicesLike>;
  };
}

/**
 * Feature-detection gate for offering the "Online Meeting" mode at all
 * (KTD-M3). Presence of `getDisplayMedia` is the load-bearing check — a
 * coarse-enough proxy for "Chromium desktop" without over-engineering UA
 * sniffing (Firefox/Safari simply don't implement it).
 */
export function canCaptureSystemAudio(env: SystemAudioEnvLike = globalThis as unknown as SystemAudioEnvLike): boolean {
  return typeof env.navigator?.mediaDevices?.getDisplayMedia === 'function';
}
