// @vitest-environment jsdom
/**
 * U8: light smoke test for `RecoveryScreen`, extracted out of the deleted
 * `App.tsx`'s `ScreenContent` `'recovery'` branch.
 */
import { cleanup, render, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryScreen } from './RecoveryScreen';
import type { SessionRecord } from '../storage/sessionStore';

afterEach(() => {
  cleanup();
});

const CANDIDATE: SessionRecord = {
  id: 'session-1',
  status: 'active',
  createdAt: 0,
  heartbeatAt: 83 * 60_000, // 1h 23min
  lastSegmentSeq: 4,
};

describe('RecoveryScreen', () => {
  it('renders the crashed-session duration headline', () => {
    const { container } = render(
      <RecoveryScreen recoveryCandidate={CANDIDATE} onRecover={() => {}} onDiscard={() => {}} />,
    );
    expect(container.textContent).toContain('1H 23MIN');
  });

  it('fires onRecover when "Fortsetzen" is clicked', () => {
    const onRecover = vi.fn();
    const { getByRole } = render(
      <RecoveryScreen recoveryCandidate={CANDIDATE} onRecover={onRecover} onDiscard={() => {}} />,
    );
    fireEvent.click(getByRole('button', { name: 'Fortsetzen' }));
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it('fires onDiscard when "Verwerfen" is clicked', () => {
    const onDiscard = vi.fn();
    const { getByRole } = render(
      <RecoveryScreen recoveryCandidate={CANDIDATE} onRecover={() => {}} onDiscard={onDiscard} />,
    );
    fireEvent.click(getByRole('button', { name: 'Verwerfen' }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('renders 0MIN when there is no candidate', () => {
    const { container } = render(<RecoveryScreen recoveryCandidate={null} onRecover={() => {}} onDiscard={() => {}} />);
    expect(container.textContent).toContain('0MIN');
  });
});
