import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { OfflineBanner } from '../src/dashboardShared';

describe('OfflineBanner', () => {
  it('shows the offline copy and fires retry when tapped', async () => {
    const onRetry = jest.fn();
    await act(async () => {
      render(<OfflineBanner onRetry={onRetry} />);
    });

    expect(screen.getByText("You're offline — showing the last saved version")).toBeTruthy();
    // WCAG: the retry control is exposed as a labelled button, not colour alone.
    const retry = screen.getByLabelText('Retry loading the latest data');
    expect(retry.props.accessibilityRole).toBe('button');

    await act(async () => {
      fireEvent.press(retry);
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('honours a custom label', async () => {
    await act(async () => {
      render(<OfflineBanner label="Showing saved report" onRetry={jest.fn()} />);
    });
    expect(screen.getByText('Showing saved report')).toBeTruthy();
  });

  it('omits the Retry control when there is nothing to retry', async () => {
    await act(async () => {
      render(<OfflineBanner />);
    });
    expect(screen.queryByText('Retry')).toBeNull();
  });
});
