import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExamBuilder from '../pages/ExamBuilder';

function json(body, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

afterEach(() => vi.unstubAllGlobals());

describe('ExamBuilder', () => {
  it('creates and saves a collection before generating from pasted notes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ collections: [] }))
      .mockResolvedValueOnce(json({ collection: { id: 'notes_1', sourceCount: 0, pageCount: 0 }, notes: '', hasEditedNotes: false }, 201))
      .mockResolvedValueOnce(json({ savedAt: '2026-07-21T00:00:00.000Z' }))
      .mockResolvedValueOnce(json({ paper: 'Paper', solutions: 'Solutions' }));
    vi.stubGlobal('fetch', fetchMock);

    render(<ExamBuilder />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText('Extracted notes will appear here. You can also paste notes directly for the demo.'), { target: { value: 'Atomic structure notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate exam and solutions' }));

    await screen.findByText('Exam paper');
    const actions = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).action);
    expect(actions).toEqual(['list_collections', 'create_collection', 'save_notes', 'generate']);
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toMatchObject({ collectionId: 'notes_1', notes: 'Atomic structure notes' });
  });
});
