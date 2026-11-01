// Settings → WhatsApp (CRM M2 phase 2 S1).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import WhatsAppSettings from '../../components/crm/comms/WhatsAppSettings';

const settings = {
  language: 'en', senderName: 'School A', contactLine: '', paymentInstructions: '',
  auto: { feeDue: true, feeOverdue: true, receipt: true, reportReady: true, absent: true },
  schedule: { remindDaysBefore: 3, overdueFirstDay: 1, overdueGapDays: 7, overdueCount: 3, sendHour: 10 },
  monthlyLimitPaise: null, version: 0, saved: false,
};
const connection = {
  id: 'wac_1', provider: 'meta', mode: 'embedded', displayPhone: '+91 98200 11122', verifiedName: 'Sharma Classes', coexistence: true,
  health: 'ok', healthReason: null, qualityRating: 'GREEN', connectedAt: '2026-10-20T05:00:00.000Z', version: 1,
};
const templates = [
  { key: 'fee_due', label: 'Fee due soon', language: 'en', status: 'approved', category: 'UTILITY' },
  { key: 'fee_due', label: 'Fee due soon', language: 'hi', status: 'pending', category: null },
  { key: 'absent', label: 'Absent today', language: 'en', status: 'rejected', reason: 'INVALID_FORMAT', category: 'UTILITY' },
];
const signup = { available: true, appId: '1', configId: '2', graphVersion: 'v23.0', solutionId: null };

function mockApi(state) {
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const path = String(url).replace('/api/auth/crm/', '');
    const body = options.body ? JSON.parse(options.body) : null;
    const reply = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
    if (path === 'settings/whatsapp' && (options.method || 'GET') === 'GET') return reply(state);
    if (path === 'settings/whatsapp' && options.method === 'POST') {
      state = { ...state, settings: { ...state.settings, ...body, version: state.settings.version + 1, saved: true } };
      return reply(state);
    }
    if (path === 'settings/whatsapp/connect-test') {
      state = { ...state, connection: { ...connection, provider: 'test', mode: 'test', coexistence: false } };
      return reply(state);
    }
    if (path === 'settings/whatsapp/disconnect') {
      expect(body).toEqual({ expectedVersion: 1 });
      state = { ...state, connection: null, templates: [] };
      return reply(state);
    }
    return reply({ error: { code: 'not_found', message: `unexpected ${path}` } }, 404);
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Settings → WhatsApp', () => {
  it('offers Connect when not connected, and explains when the server is not set up', async () => {
    mockApi({ connection: null, templates: [], settings, signup, platform: false });
    render(<WhatsAppSettings />);
    expect(await screen.findByRole('button', { name: 'Connect our WhatsApp Business number' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect a new number' })).toBeInTheDocument();
    expect(screen.queryByText('Skyll support')).not.toBeInTheDocument();
    cleanup();

    mockApi({ connection: null, templates: [], settings, signup: { ...signup, available: false }, platform: false });
    render(<WhatsAppSettings />);
    expect(await screen.findByText(/isn’t set up on this server yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect our/ })).not.toBeInTheDocument();
  });

  it('shows the connected number, health, coexistence and template approvals', async () => {
    mockApi({ connection, templates, settings, signup, platform: false });
    render(<WhatsAppSettings />);
    expect(await screen.findByText('+91 98200 11122')).toBeInTheDocument();
    expect(screen.getByText('Phone app still works')).toBeInTheDocument();
    expect(screen.getByText(/at least once every two weeks/)).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 approved/)).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toHaveAttribute('title', 'INVALID_FORMAT');
    cleanup();

    mockApi({ connection: { ...connection, health: 'blocked', healthReason: 'Meta could not charge the class’s payment method; update it in Meta Business Suite' }, templates, settings, signup, platform: false });
    render(<WhatsAppSettings />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Messages are on hold.*payment method/);
  });

  it('previews the reminder with the class details and saves every setting', async () => {
    mockApi({ connection, templates, settings, signup, platform: false });
    render(<WhatsAppSettings />);
    const sender = await screen.findByLabelText('Sender name');
    fireEvent.change(sender, { target: { value: 'Sharma Classes, Andheri' } });
    fireEvent.change(screen.getByLabelText('Payment instructions (optional)'), { target: { value: 'Pay by UPI to sharma@okhdfc' } });
    expect(screen.getByTestId('wa-preview')).toHaveTextContent('fee reminder from Sharma Classes, Andheri');
    expect(screen.getByTestId('wa-preview')).toHaveTextContent('How to pay: Pay by UPI to sharma@okhdfc');
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'hi' } });
    expect(screen.getByTestId('wa-preview')).toHaveTextContent('नमस्ते');

    fireEvent.click(screen.getByLabelText(/Absent today/));
    fireEvent.change(screen.getByLabelText('Days before the due date'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Limit in ₹ (optional)'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Saved');
    const [, saveCall] = globalThis.fetch.mock.calls.find(([url, options]) => String(url).endsWith('settings/whatsapp') && options?.method === 'POST');
    expect(JSON.parse(saveCall.body)).toEqual({
      language: 'hi', senderName: 'Sharma Classes, Andheri', contactLine: '', paymentInstructions: 'Pay by UPI to sharma@okhdfc',
      auto: { feeDue: true, feeOverdue: true, receipt: true, reportReady: true, absent: false },
      schedule: { remindDaysBefore: 5, overdueFirstDay: 1, overdueGapDays: 7, overdueCount: 3, sendHour: 10 },
      monthlyLimitPaise: 50000, expectedVersion: 0,
    });
    expect(saveCall.headers['Idempotency-Key']).toBeTruthy();
  });

  it('checks the schedule before saving', async () => {
    mockApi({ connection, templates, settings, signup, platform: false });
    render(<WhatsAppSettings />);
    fireEvent.change(await screen.findByLabelText('Overdue reminders at most'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter 0–5')).toBeInTheDocument();
    expect(globalThis.fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('lets platform staff use the test provider, and admins disconnect', async () => {
    mockApi({ connection: null, templates: [], settings, signup, platform: true });
    render(<WhatsAppSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use test provider' }));
    expect(await screen.findByText('Test provider (no real messages)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect', hidden: false, description: undefined }));
    await waitFor(() => expect(screen.getByText(/Not connected/)).toBeInTheDocument());
  });
});
