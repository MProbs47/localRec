import type { SessionRecord } from '../storage/sessionStore';
import { t } from '../i18n';
import { formatRecoveryDuration } from './format';

export interface RecoveryScreenProps {
  recoveryCandidate: SessionRecord | null;
  onRecover: () => void;
  onDiscard: () => void;
}

/**
 * §8 recovery offer. U8: extracted from the deleted `ScreenContent`'s
 * `'recovery'` branch, narrowed to its own three props instead of the full
 * 22-prop pass-through.
 */
export function RecoveryScreen({ recoveryCandidate, onRecover, onDiscard }: RecoveryScreenProps) {
  // Duration = last durable heartbeat minus session start (U6 crash-freshness).
  const durationMs = recoveryCandidate ? Math.max(0, recoveryCandidate.heartbeatAt - recoveryCandidate.createdAt) : 0;
  return (
    <div className="recovery">
      <p className="recovery__headline">
        {t('recovery.headline', { duration: formatRecoveryDuration(durationMs) })}
      </p>
      <div className="recovery__options">
        <button type="button" className="recovery__option" onClick={onRecover}>
          {t('recovery.resume')}
        </button>
        <button type="button" className="recovery__option recovery__option--ghost" onClick={onDiscard}>
          {t('recovery.discard')}
        </button>
      </div>
    </div>
  );
}
