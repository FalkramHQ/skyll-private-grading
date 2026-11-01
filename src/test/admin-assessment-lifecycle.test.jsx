import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminDashboard from '../pages/Admin';

const baseTest = {
  id: 'test-1', title: 'Physics unit test', school: 'Partner Academy E', subject: 'Physics', grade: '12th', uploadedStudents: 24, expectedStudents: 24, answerSheets: 24, updatedAt: '2026-07-25T10:00:00.000Z',
};

function renderDashboard(test) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ tests: [test] }) });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><AdminDashboard /></MemoryRouter>);
  return fetchMock;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('admin assessment lifecycle', () => {
  it('renders the canonical status and safe retry instead of a raw job error', async () => {
    renderDashboard({ ...baseTest, assessment: { state: 'needs_attention', label: 'Needs attention', tone: 'warning', explanation: 'Processing needs an administrator decision before it can continue.', updatedAt: baseTest.updatedAt, attention: { summary: 'OCR needs attention before processing can continue.', code: 'worker_lease_expired' }, action: { id: 'retry_ocr', label: 'Retry OCR' } }, ocrJob: { error: 'internal secret stack trace' } });
    expect(await screen.findByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('Error code: worker_lease_expired')).toBeInTheDocument();
    expect(screen.queryByText('internal secret stack trace')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry OCR' })).toBeInTheDocument();
  });

  it('posts only the contract-provided processing action and refreshes the projection', async () => {
    const fetchMock = renderDashboard({ ...baseTest, assessment: { state: 'ready_to_process', label: 'Ready to process', tone: 'ready', explanation: 'All required files are available. Start processing when you are ready.', updatedAt: baseTest.updatedAt, action: { id: 'start_ocr', label: 'Start processing' } } });
    await screen.findByRole('button', { name: 'Start processing' });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ job: { id: 'job-1' } }) });
    fireEvent.click(screen.getByRole('button', { name: 'Start processing' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/intake/jobs', expect.objectContaining({ method: 'POST', body: JSON.stringify({ testId: 'test-1', action: 'start_ocr' }) })));
  });

  it('sends recovery actions to the operations route and refreshes', async () => {
    const fetchMock = renderDashboard({ ...baseTest, assessment: { state: 'needs_attention', label: 'Needs attention', tone: 'warning', explanation: 'Processing needs an administrator decision before it can continue.', updatedAt: baseTest.updatedAt, attention: { summary: 'Grading needs attention before processing can continue.', code: 'model_timeout', action: { id: 'retry_failed_jobs', label: 'Retry failed jobs' } }, action: { id: 'retry_failed_jobs', label: 'Retry failed jobs' } } });
    await screen.findByRole('button', { name: 'Retry failed jobs' });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, jobsReset: 3 }) });
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed jobs' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/operations/jobs', expect.objectContaining({ method: 'POST', body: JSON.stringify({ testId: 'test-1', action: 'retry_failed_jobs' }) })));
    // The projection is reloaded after the action succeeds.
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/operations').length).toBe(2));
  });

  it('renders the reconcile action for a stalled assessment', async () => {
    renderDashboard({ ...baseTest, assessment: { state: 'needs_attention', label: 'Needs attention', tone: 'warning', explanation: 'The assessment is recorded as in progress, but no processing job is queued or running for it.', updatedAt: baseTest.updatedAt, attention: { summary: 'The pipeline stopped without recording its outcome.', code: 'no_active_job' }, action: { id: 'reconcile_status', label: 'Reconcile status' } } });
    expect(await screen.findByRole('button', { name: 'Reconcile status' })).toBeInTheDocument();
    expect(screen.getByText('Error code: no_active_job')).toBeInTheDocument();
  });

  it('summarises the latest regrade run and retries a partial run through vl-queue', async () => {
    const fetchMock = renderDashboard({ ...baseTest, assessment: { state: 'ready_for_review', label: 'Ready for review', tone: 'ready', explanation: 'Ready.', updatedAt: baseTest.updatedAt, action: null }, regrade: { runId: 'run_1', status: 'partial', requestedAt: null, items: { queued: 0, processing: 0, completed: 12, failed: 1 }, total: 40, retryable: true, error: null } });
    expect(await screen.findByText(/partially complete 12\/40 · 1 failed/)).toBeInTheDocument();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ ok: true }) });
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed regrade' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/vl-queue', expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'retry-cohort-regrade', runId: 'run_1' }) })));
  });

  it('hides the regrade retry while a run is still running', async () => {
    renderDashboard({ ...baseTest, assessment: { state: 'ready_for_review', label: 'Ready for review', tone: 'ready', explanation: 'Ready.', updatedAt: baseTest.updatedAt, action: null }, regrade: { runId: 'run_1', status: 'running', requestedAt: null, items: { queued: 20, processing: 8, completed: 12, failed: 0 }, total: 40, retryable: false, error: null } });
    expect(await screen.findByText(/running 12\/40 · 8 in progress/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry failed regrade' })).not.toBeInTheDocument();
  });

  it('shows live worker pipeline progress without exposing raw job errors', async () => {
    renderDashboard({ ...baseTest, assessment: { state: 'processing', label: 'Processing', tone: 'info', explanation: 'Processing is underway.', updatedAt: baseTest.updatedAt, processing: { current: { label: 'Answer evidence', status: 'running', detail: 'Question evidence materialized for 12/24 student(s)', attemptCount: 2 }, stages: { ocr: { succeeded: 1 }, evidence: { running: 1 }, grading: { queued: 24 } } } } });
    expect(await screen.findByText('Pipeline progress')).toBeInTheDocument();
    expect(screen.getByText('Question evidence materialized for 12/24 student(s)')).toBeInTheDocument();
    expect(screen.getByText('Retry attempt 2')).toBeInTheDocument();
    expect(screen.getByText(/Grading:/)).toBeInTheDocument();
  });

  it.each([
    ['draft', 'Draft'], ['uploading', 'Uploading'], ['ready_to_process', 'Ready to process'], ['queued', 'Queued'], ['processing', 'Processing'], ['ready_for_review', 'Ready for review'], ['published', 'Published'], ['needs_attention', 'Needs attention'], ['cancelled', 'Cancelled'],
  ])('renders the %s lifecycle state', async (state, label) => {
    renderDashboard({ ...baseTest, assessment: { state, label, tone: 'neutral', explanation: 'Lifecycle explanation.', updatedAt: baseTest.updatedAt, action: state === 'published' || state === 'cancelled' ? null : { id: 'refresh', label: 'Refresh status' } } });
    expect((await screen.findAllByText(label)).at(-1)).toBeInTheDocument();
  });
});
