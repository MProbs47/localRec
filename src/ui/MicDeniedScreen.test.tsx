// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MicDeniedScreen } from './MicDeniedScreen';

describe('MicDeniedScreen', () => {
  it('names the denial and fires onRetry from "Erneut versuchen"', () => {
    const onRetry = vi.fn();
    render(<MicDeniedScreen onRetry={onRetry} />);

    expect(screen.getByText('Mikrofon-Zugriff abgelehnt.')).toBeInTheDocument();
    // role="alert" so assistive tech announces the denial.
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
