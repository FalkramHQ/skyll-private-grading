// useDraft keeps an edit made right after the first paint (#397). The layout
// effect below stands in for a click or keystroke that lands after React
// commits but before it flushes passive effects, which is what a busy CI
// runner does to findBy* + fireEvent.
import { useEffect, useLayoutEffect, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useDraft } from '../../lib/crm/useDraft';

function useEffectCopy(value) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return [draft, setDraft];
}

function Field({ value, useHook, editOnMount }) {
  const [draft, setDraft] = useHook(value);
  useLayoutEffect(() => { if (editOnMount) setDraft(editOnMount); }, [editOnMount, setDraft]);
  return <input aria-label="Name" value={draft} onChange={(event) => setDraft(event.target.value)} />;
}

afterEach(cleanup);

describe('useDraft', () => {
  it('keeps an edit made before effects flush, where the effect copy loses it', () => {
    const { unmount } = render(<Field value="Application" useHook={useEffectCopy} editOnMount="Applied" />);
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Application');
    unmount();

    render(<Field value="Application" useHook={useDraft} editOnMount="Applied" />);
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Applied');
  });

  it('keeps edits across re-renders and resets when the saved value changes', () => {
    const { rerender } = render(<Field value="Application" useHook={useDraft} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Applied' } });
    rerender(<Field value="Application" useHook={useDraft} />);
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Applied');

    rerender(<Field value="Applicant" useHook={useDraft} />);
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Applicant');
  });

  it('derives the draft with the mapper, also after a reset', () => {
    const toRows = (windows) => windows.map((window) => ({ ...window }));
    function Rows({ windows }) {
      const [rows] = useDraft(windows, toRows);
      return <p>{rows.map((row) => row.day).join(',')}</p>;
    }
    const { rerender } = render(<Rows windows={[{ day: 'Mon' }]} />);
    expect(screen.getByText('Mon')).toBeInTheDocument();
    rerender(<Rows windows={[{ day: 'Tue' }, { day: 'Wed' }]} />);
    expect(screen.getByText('Tue,Wed')).toBeInTheDocument();
  });
});
