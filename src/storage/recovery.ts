/**
 * Crash-recovery decision/data logic for U6 (R16, AE2, KTD6's state
 * diagram: `Abgebrochen -> Wiederherstellung -> Geschlossen`). Pure storage-
 * layer logic on top of `sessionStore.ts` — no React/DOM/UI here (the
 * recovery *offer* UI is U12's job; this module only answers "is there
 * something to recover" and "recover it").
 *
 * **Why "active on next start" IS the crash signal (no separate liveness
 * check needed).** `SessionStore.closeSession()` is the only code path that
 * ever sets `status: 'closed'` (see `sessionStore.ts`), and it only runs on
 * a clean stop. So any session still `status: 'active'` when the app starts
 * up again — this module's `findCrashCandidates()` — by construction never
 * got a clean stop: either the tab/process died mid-recording, or (per
 * KTD6) `beforeunload`/`visibilitychange` fired but those are documented as
 * *hints*, never the primary path, so they're not what flips `status` here
 * either. `heartbeatAt` isn't part of this decision at all — it's a
 * freshness/UI signal (e.g. U12 could show "last saved 2 minutes before the
 * crash"), not what makes something a crash candidate.
 *
 * **Why `recoverSession()` doesn't try to resume live inference.** A
 * crashed session's model KV-cache/`ModelEngine` session is gone with the
 * process — there is nothing live to reattach to (unlike a U5 sub-session
 * cut, which is a deliberate, in-process handoff). Recovery here means
 * "reconstruct the persisted transcript up to the last durable write and
 * stop treating this session as an open crash candidate" — i.e. it
 * completes the interrupted session by transitioning it `active -> closed`
 * (KTD6 diagram), exactly as if the user had stopped cleanly, just late.
 * Continuing to record is, from the app's perspective, simply *starting a
 * new session* afterward — nothing this module needs to arrange.
 *
 * **Idempotency is structural, not special-cased.** `recoverSession()` is a
 * read (`getSession`/`listSegments`, both already dedup'd/ordered by
 * `sessionStore.ts`'s compound key) plus, at most, one `active -> closed`
 * transition. Once a session is `closed`, calling this again just skips the
 * transition (`recovered: false`) and returns the same read — nothing here
 * needs its own de-duplication bookkeeping, because there is no second
 * write path to de-duplicate against.
 */

import type { SegmentRecord, SessionRecord, SessionStore } from './sessionStore';

export interface RecoveryOutcome {
  /** `true` only when this call actually performed the `active -> closed` transition; `false` for the idempotent no-op case (already closed). */
  recovered: boolean;
  /** The session record as it stands after this call (already reflecting the transition, if one happened). */
  session: SessionRecord;
  /** Every persisted segment for this session, ascending by `seq`, exactly once each — no duplicates, nothing synthesized for gaps. */
  segments: SegmentRecord[];
}

/**
 * All sessions that look like crash candidates on app start: `status`
 * still `'active'` (AE2, test scenario 1). Named separately from
 * `SessionStore.listActiveSessions()` — same query, but this is the
 * recovery-domain vocabulary (`recovery.ts` is where "active on start ==
 * crash candidate" is a documented decision, not just a raw store listing)
 * that U12's recovery-offer UI is meant to call.
 */
export async function findCrashCandidates(store: SessionStore): Promise<SessionRecord[]> {
  return store.listActiveSessions();
}

/**
 * Reconstructs one session's persisted state and, if it was still `active`
 * (a crash candidate), completes it by transitioning to `closed` — see file
 * header for why that's the right terminal state rather than trying to
 * resume live inference. Returns `null` if the session was never created at
 * all (nothing to recover). Safe to call more than once for the same
 * session: only the first call (while still `active`) performs the write;
 * every later call is a pure read returning `recovered: false` with the
 * identical `segments`/`session.status` — the idempotency the plan's test
 * scenario 2 requires.
 */
export async function recoverSession(
  store: SessionStore,
  sessionId: string,
  now: number,
): Promise<RecoveryOutcome | null> {
  const session = await store.getSession(sessionId);
  if (!session) return null;

  const segments = await store.listSegments(sessionId);

  if (session.status === 'active') {
    await store.closeSession(sessionId, now);
    return { recovered: true, session: { ...session, status: 'closed', heartbeatAt: now }, segments };
  }

  return { recovered: false, session, segments };
}
