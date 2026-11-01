import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AnswerSheetGallery from '../components/AnswerSheetGallery';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('answer-sheet gallery', () => {
  it('requests the selected student\'s scanned pages when viewed by a teacher', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pages: [1, 2] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AnswerSheetGallery subjects={[{ name: 'Chemistry' }]} studentUsername="partnerb_student01" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/student-answer-sheet?subject=Chemistry&student=partnerb_student01');
    });
    expect(await screen.findByText('Handwritten answer sheet')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next answer-sheet page' }));
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous answer-sheet page' })).not.toBeDisabled();
  });

  it('uses the current assessment when a student has multiple reports', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pages: [1] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AnswerSheetGallery subjects={[{ name: 'Mathematics' }]} studentUsername="achieve01" testId="test_123" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/student-answer-sheet?subject=Mathematics&student=achieve01&testId=test_123');
    });
  });

  it('shows "Page unavailable" instead of an endless skeleton when a page fails to load', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ pages: [1, 2] }) }));
    render(<AnswerSheetGallery subjects={[{ name: 'Physics' }]} studentUsername="partnerb_student02" />);
    const page = await screen.findByRole('img', { name: 'Physics answer sheet, page 1' });
    fireEvent.error(page);
    expect(screen.getByText('Page unavailable')).toBeInTheDocument();
    // Moving to another page tries again.
    fireEvent.click(screen.getByRole('button', { name: 'Next answer-sheet page' }));
    expect(screen.queryByText('Page unavailable')).toBeNull();
  });
});
