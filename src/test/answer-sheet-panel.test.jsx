import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import {
  AnswerSheetPanel,
  answerLocationLabel,
  findAnswerLocation,
  useAnswerLocations,
} from '../components/AnswerSheetPanel';

const PAGE_HEIGHT = 1000;
const PANEL_HEIGHT = 600;

function pageNumberOf(element) {
  return Number(element.closest?.('[data-page]')?.getAttribute('data-page') || 0);
}

describe('answerLocationLabel', () => {
  it('describes each kind of location', () => {
    expect(answerLocationLabel(null)).toBeNull();
    expect(answerLocationLabel({ page: 3, match: 'unique', answered: true })).toBe('Page 3');
    expect(answerLocationLabel({ page: 3, match: 'ambiguous', answered: true })).toBe('Page 3');
    expect(answerLocationLabel({ page: 2, match: 'inferred', answered: false })).toBe('Likely page 2 · not attempted');
    expect(answerLocationLabel({ page: 2, match: 'inferred', answered: true })).toBe('Likely page 2');
    expect(answerLocationLabel({ page: null, match: 'none', answered: true })).toBe('Not found on sheet');
  });
});

describe('findAnswerLocation', () => {
  const data = { locations: [{ id: 'sq_1', questionNumber: 'Q1', page: 1 }, { questionNumber: 'Q2', page: 4 }] };
  it('matches by review item id, then by question number', () => {
    expect(findAnswerLocation(data, { id: 'sq_1', questionNumber: 'Q9' }).page).toBe(1);
    expect(findAnswerLocation(data, { id: 'other', questionNumber: 'Q2' }).page).toBe(4);
    expect(findAnswerLocation(data, { id: 'x', questionNumber: 'Q7' })).toBeNull();
    expect(findAnswerLocation(null, { id: 'sq_1' })).toBeNull();
  });
});

describe('AnswerSheetPanel', () => {
  let scrollTo;
  const restore = [];

  function stub(property, getter) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property);
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, get: getter });
    restore.push(() => {
      if (original) Object.defineProperty(HTMLElement.prototype, property, original);
      else delete HTMLElement.prototype[property];
    });
  }

  beforeEach(() => {
    scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo;
    stub('offsetTop', function offsetTop() {
      const page = this.getAttribute('data-page');
      return page ? (Number(page) - 1) * PAGE_HEIGHT : 0;
    });
    stub('offsetHeight', function offsetHeight() { return pageNumberOf(this) ? PAGE_HEIGHT : 0; });
    stub('clientHeight', function clientHeight() { return PANEL_HEIGHT; });
  });

  afterEach(() => {
    cleanup();
    delete HTMLElement.prototype.scrollTo;
    restore.splice(0).forEach((undo) => undo());
  });

  const props = { testId: 'test_1', testStudentId: 'ts_1', subject: 'Physics', pageCount: 4 };

  it('scrolls the panel to the estimated answer position and outlines that page', () => {
    const { container, rerender } = render(
      <AnswerSheetPanel {...props} focusKey="sq_1" location={{ page: 3, offset: 0.5, match: 'unique' }} />,
    );
    // page 3 top 2000 + half its height 500 - 15% of the panel 90
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 2410, behavior: 'smooth' });
    expect(container.querySelector('[data-page="3"]').className).toContain('ring-2');

    rerender(<AnswerSheetPanel {...props} focusKey="sq_2" location={{ page: 1, offset: 0.02, match: 'unique' }} />);
    // never above the top of the target page (minus a little padding)
    expect(scrollTo).toHaveBeenLastCalledWith({ top: -8, behavior: 'smooth' });
    expect(container.querySelector('[data-page="1"]').className).toContain('ring-2');
    expect(container.querySelector('[data-page="3"]').className).not.toContain('ring-2');
  });

  it('shows the end of the previous page above an inferred page-boundary gap', () => {
    render(<AnswerSheetPanel {...props} focusKey="sq_1" location={{ page: 3, offset: 0, match: 'inferred' }} />);
    // page 3 top 2000 - 15% of the panel 90, not clamped to the page top
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1910, behavior: 'smooth' });
  });

  it('re-aims instantly as pages above the target load, until the reviewer scrolls by hand', () => {
    const { container } = render(<AnswerSheetPanel {...props} focusKey="sq_1" location={{ page: 3, offset: 0.5, match: 'unique' }} />);
    const scrollBox = container.querySelector('[data-testid="answer-sheet-scroll"]');
    expect(scrollTo).toHaveBeenCalledTimes(1);

    fireEvent.load(container.querySelector('img[alt="Page 4"]'));
    expect(scrollTo).toHaveBeenCalledTimes(1);

    fireEvent.load(container.querySelector('img[alt="Page 2"]'));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 2410, behavior: 'auto' });
    expect(scrollTo).toHaveBeenCalledTimes(2);

    fireEvent.wheel(scrollBox);
    fireEvent.load(container.querySelector('img[alt="Page 1"]'));
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('reserves the real sheet shape once a page reports it, and re-aims for the new layout', () => {
    const { container } = render(<AnswerSheetPanel {...props} focusKey="sq_1" location={{ page: 4, offset: 0.2, match: 'unique' }} />);
    const reserved = () => container.querySelector('[data-page="4"] [style]').style.aspectRatio;
    expect(reserved()).toBe('1 / 1.414');

    const first = container.querySelector('img[alt="Page 1"]');
    Object.defineProperty(first, 'naturalWidth', { configurable: true, value: 1000 });
    Object.defineProperty(first, 'naturalHeight', { configurable: true, value: 1300 });
    fireEvent.load(first);

    expect(reserved()).toBe('1 / 1.3');
    // once from the load itself, once after the placeholders took the new shape
    expect(scrollTo.mock.calls.filter(([arg]) => arg.behavior === 'auto')).toHaveLength(2);
  });

  it('starts a newly selected student at the top of their sheet', () => {
    const { rerender } = render(<AnswerSheetPanel {...props} focusKey="sq_1" location={{ page: 3, offset: 0.5, match: 'unique' }} />);
    rerender(<AnswerSheetPanel {...props} testStudentId="ts_2" focusKey="sq_9" location={null} />);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' });
  });

  it('scrolls again when a different question lands on the same spot', () => {
    const location = { page: 2, offset: 0.1, match: 'inferred' };
    const { rerender } = render(<AnswerSheetPanel {...props} focusKey="sq_1" location={location} />);
    rerender(<AnswerSheetPanel {...props} focusKey="sq_2" location={location} />);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('leaves the scroll alone when the answer cannot be placed', () => {
    render(<AnswerSheetPanel {...props} focusKey="sq_1" location={{ page: null, offset: null, match: 'none' }} />);
    render(<AnswerSheetPanel {...props} focusKey="sq_2" location={null} />);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('loads the target page eagerly even when it is far down the sheet', () => {
    const { container } = render(<AnswerSheetPanel {...props} focusKey="sq_1" location={{ page: 4, offset: 0, match: 'unique' }} />);
    expect(container.querySelector('img[alt="Page 4"]').getAttribute('loading')).toBe('eager');
    expect(container.querySelector('img[alt="Page 3"]').getAttribute('loading')).toBe('lazy');
  });
});

describe('useAnswerLocations', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('fetches once per student and reuses the result', async () => {
    const payload = { locations: [{ id: 'sq_1', questionNumber: 'Q1', page: 2 }] };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => payload }));
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(({ testStudentId }) => useAnswerLocations('test_1', testStudentId), {
      initialProps: { testStudentId: 'ts_1' },
    });
    await waitFor(() => expect(result.current).toEqual(payload));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: 'answer-locations', testId: 'test_1', testStudentId: 'ts_1' });

    rerender({ testStudentId: 'ts_2' });
    expect(result.current).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => { rerender({ testStudentId: 'ts_1' }); });
    await waitFor(() => expect(result.current).toEqual(payload));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries after a failed lookup', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ locations: [] }) }))
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'boom' }) });
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(({ id }) => useAnswerLocations('test_1', id), { initialProps: { id: 'ts_1' } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => { rerender({ id: 'ts_2' }); });
    await act(async () => { rerender({ id: 'ts_1' }); });
    await waitFor(() => expect(result.current).toEqual({ locations: [] }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
