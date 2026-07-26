/**
 * U8: formatting helpers used across the device's footer/screens — moved
 * out of `App.tsx` verbatim (the presentation-extraction unit of the
 * recording-session aggregate refactor).
 */
import { t } from '../i18n';

/** mm:ss / HH:MM:SS recording timer (§4/§8), always zero-padded. */
export function formatTimer(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** Short elapsed format for the importing screen: "5:30", or "1:05:30" past an hour. */
export function formatElapsedShort(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * Human-readable crashed-session length for the recovery headline (§8),
 * e.g. "1H 23MIN". `H`/`MIN` come from `format.hours`/`format.minutes` —
 * extracted for key-completeness (every locale must supply them) but
 * deliberately NOT translated (device-label characters, Owner decision on
 * plan open point 4): they read identically in all five tables.
 */
export function formatRecoveryDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0
    ? `${hours}${t('format.hours')} ${minutes}${t('format.minutes')}`
    : `${minutes}${t('format.minutes')}`;
}
