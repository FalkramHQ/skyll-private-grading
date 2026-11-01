// The Communications page (CRM M2 phase 2 S5).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CommunicationsPage from '../../components/crm/comms/CommunicationsPage';

const me = { capabilities: ['crm.access', 'crm.comms.read', 'crm.comms.send', 'crm.settings.manage'], school: { timezone: 'Asia/Kolkata' } };
const messages = {
  items: [
    { id: 'm1', at: '2026-10-20T05:00:00.000Z', kind: 'fee_overdue', via: 'api', status: 'failed', statusReason: 'WhatsApp is busy. Gave up after 5 attempts.', retryable: true, recipientName: 'Kavita Sharma', actorName: null, body: '₹5,500 is overdue', amountsHidden: false, subjects: [{ entityType: 'student', entityId: 'stu_1', name: 'Demo Student One' }] },
    { id: 'm2', at: '2026-10-20T04:00:00.000Z', kind: 'notice', via: 'api', status: 'read', statusReason: null, retryable: false, recipientName: 'Rohit Sharma', actorName: 'Admin A', body: 'Class cancelled', amountsHidden: false, subjects: [] },
  ],
  nextCursor: null,
};
const replies = {
  items: [{ id: 'r1', at: '2026-10-20T06:00:00.000Z', contactId: 'ct_k', fromName: 'Kavita Sharma', fromPhone: '+919800000001', body: 'Will pay Friday', mediaLabel: null, isStop: false, records: [{ entityType: 'student', entityId: 'stu_1', name: 'Demo Student One' }], windowOpen: true }],
  nextCursor: null,
};

function mockApi(status = { connection: { displayPhone: '+91 98200 11122', health: 'ok' }, held: 0, failedThisWeek: 1, queued: 0, canManage: true }) {
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const path = String(url).replace('/api/auth/crm/', '');
    const reply = (payload, code = 200) => ({ ok: code < 400, status: code, json: async () => payload });
    if (path === 'messages/status') return reply(status);
    if (path.startsWith('messages/replies')) return reply(path.includes('unknown') ? { items: [], nextCursor: null } : replies);
    if (path.startsWith('messages?') && (options.method || 'GET') === 'GET') return reply(messages);
    if (path === 'messages/retry') return reply({ status: 'queued' });
    if (path === 'messages/group/options') return reply({ batches: [{ id: 'b1', name: 'Grade 10 Maths', students: 9 }], courses: [], canFilterOverdue: true });
    if (path.startsWith('messages/group/preview')) {
      return reply({
        target: { entityType: 'group', label: '9 students', studentCount: 9 }, connection: { displayPhone: '+91', health: 'ok' }, language: 'en', senderName: 'Sharma Classes',
        notices: [{ key: 'notice_holiday', label: 'Holiday', fields: ['dates', 'occasion'] }],
        recipients: [{ contactId: 'ct_k', name: 'Kavita Sharma', phone: null, consent: true, windowOpen: false, students: ['A'] }], skipped: [], estimate: { total: '≈ ₹0.14' },
      });
    }
    if (path === 'messages/group' && options.method === 'POST') return reply({ queued: 1, skipped: 0 }, 201);
    return reply({ error: { code: 'not_found', message: path } }, 404);
  });
}
const renderPage = (entry = '/crm/communications') => render(<MemoryRouter initialEntries={[entry]}><CommunicationsPage me={me} /></MemoryRouter>);

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Communications', () => {
  it('lists messages with status, reasons, text on demand and Retry', async () => {
    mockApi();
    renderPage();
    const list = await screen.findByRole('list', { name: 'Messages' });
    expect(within(list).getByText('Failed')).toBeInTheDocument();
    expect(within(list).getByText('WhatsApp is busy. Gave up after 5 attempts.')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Demo Student One' })).toHaveAttribute('href', '/crm/students/stu_1');
    fireEvent.click(within(list).getAllByRole('button', { name: 'Show text' })[0]);
    expect(within(list).getByText('₹5,500 is overdue')).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(globalThis.fetch.mock.calls.some(([url]) => String(url).endsWith('messages/retry'))).toBe(true));
    expect(screen.getByText(/1 failed this week/)).toBeInTheDocument();
  });

  it('shows the banner when not connected or on hold', async () => {
    mockApi({ connection: null, held: 0, failedThisWeek: 0, queued: 0, canManage: true });
    renderPage();
    expect(await screen.findByRole('link', { name: 'Connect WhatsApp' })).toHaveAttribute('href', '/crm/settings?tab=whatsapp');
    cleanup();
    mockApi({ connection: { displayPhone: '+91', health: 'blocked', healthReason: 'Meta could not charge the class’s payment method' }, held: 12, failedThisWeek: 0, queued: 0, canManage: true });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('WhatsApp messages are on hold (12 waiting). Meta could not charge');
  });

  it('shows replies with Reply', async () => {
    mockApi();
    renderPage('/crm/communications?tab=replies');
    const list = await screen.findByRole('list', { name: 'Replies' });
    expect(within(list).getByText('Will pay Friday')).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Reply' })).toBeInTheDocument();
  });

  it('sends a class notice to a filtered group', async () => {
    mockApi();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New class notice' }));
    fireEvent.click(await screen.findByLabelText(/Grade 10 Maths/));
    expect(await screen.findByText(/Goes to 1 guardian/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Date or dates'), { target: { value: '1 Nov' } });
    fireEvent.change(screen.getByLabelText('Occasion'), { target: { value: 'Diwali' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to 1' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Sending to 1 guardians');
    const [, post] = globalThis.fetch.mock.calls.find(([url, options]) => String(url).endsWith('messages/group') && options?.method === 'POST');
    expect(JSON.parse(post.body)).toEqual({ filters: { batchIds: ['b1'], overdueOnly: false }, templateKey: 'notice_holiday', fields: { dates: '1 Nov', occasion: 'Diwali' } });
  });
});
