// Fee reminders on the Fees screens and the parent fees page (CRM M2 phase 2 S3).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ReminderStrip, SendReminderDialog } from '../../components/crm/comms/FeeReminders';
import ParentFees from '../../pages/ParentFees';

const status = {
  connected: true, payer: { name: 'Kavita Sharma', consent: true, hasPhone: true }, pausedUntil: null,
  last: { kind: 'fee_overdue', status: 'read', at: '2026-10-18T04:30:00.000Z', via: 'api' }, sentToday: false, nothingDue: false,
};

function mockApi(reminders, onPost = () => ({ queued: 1, templateKey: 'fee_overdue' })) {
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const path = String(url).replace('/api/auth/crm/', '');
    const reply = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
    if (path.startsWith('fees/reminders?')) return reply(reminders);
    if (options.method === 'POST') return reply(onPost(path, JSON.parse(options.body)));
    return reply({ error: { code: 'not_found', message: path } }, 404);
  });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Send reminder', () => {
  it('sends on WhatsApp when it can', async () => {
    mockApi(status);
    render(<SendReminderDialog open studentId="stu_1" studentName="Anaya" onClose={() => {}} />);
    expect(await screen.findByText(/Last: Overdue fee reminder/)).toHaveTextContent('Read');
    fireEvent.click(screen.getByRole('button', { name: 'Send on WhatsApp' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Sending the overdue reminder');
  });

  it('offers only the phone when already reminded today, unconnected or without consent', async () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    for (const [change, text] of [[{ sentToday: true }, /already reminded today/], [{ connected: false }, /WhatsApp isn’t connected/], [{ payer: { name: 'Kavita Sharma', consent: false, hasPhone: true } }, /hasn’t agreed/]]) {
      mockApi({ ...status, ...change }, () => ({ link: 'https://wa.me/919800000001?text=x' }));
      render(<SendReminderDialog open studentId="stu_1" studentName="Anaya" onClose={() => {}} />);
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Send on WhatsApp' })).not.toBeInTheDocument();
      cleanup();
    }
    mockApi({ ...status, sentToday: true }, () => ({ link: 'https://wa.me/919800000001?text=x' }));
    render(<SendReminderDialog open studentId="stu_1" studentName="Anaya" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Send from my phone/ }));
    expect(await screen.findByRole('status')).toHaveTextContent('Opened WhatsApp on this device');
    expect(opened).toHaveBeenCalledWith('https://wa.me/919800000001?text=x', '_blank', 'noopener');
  });
});

describe('the reminder strip', () => {
  const me = { capabilities: ['crm.finance.read', 'crm.finance.write', 'crm.comms.send'] };
  it('pauses and resumes a student’s reminders', async () => {
    const posts = [];
    mockApi(status, (path, body) => { posts.push([path, body]); return { pausedUntil: body.untilDate }; });
    render(<ReminderStrip me={me} student={{ id: 'stu_1', name: 'Anaya' }} today="2026-10-20" />);
    fireEvent.click(await screen.findByRole('button', { name: /Pause/ }));
    expect(screen.getByLabelText('Pause until')).toHaveValue('2026-10-27');
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await vi.waitFor(() => expect(posts[0]).toEqual(['fees/reminders/pause', { studentId: 'stu_1', untilDate: '2026-10-27' }]));
    cleanup();
    mockApi({ ...status, pausedUntil: '2026-10-27' }, (path, body) => { posts.push([path, body]); return {}; });
    render(<ReminderStrip me={me} student={{ id: 'stu_1', name: 'Anaya' }} today="2026-10-20" />);
    expect(await screen.findByText(/Reminders paused until/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await vi.waitFor(() => expect(posts.at(-1)).toEqual(['fees/reminders/pause', { studentId: 'stu_1', untilDate: null }]));
  });
});

describe('the parent fees page', () => {
  const page = {
    school: { name: 'Sharma Classes', address: null, phone: '022 5555 0101' }, guardianName: 'Kavita Sharma', paymentInstructions: 'Pay by UPI to sharma@okhdfc', contactLine: null, language: 'en',
    expiresAt: '2026-12-19T06:00:00.000Z', today: '2026-10-20',
    children: [{
      name: 'Anaya Iyer', summary: { balancePaise: 600000, overduePaise: 600000, creditPaise: 0, nextDue: { dueDate: '2026-10-19', amountPaise: 600000 } },
      invoices: [{ id: 'inv_1', number: 'SDS/INV/2026-27/0001', dueDate: '2026-10-19', totalPaise: 1000000, paidPaise: 400000, balancePaise: 600000, paymentStatus: 'partly_paid', overdue: true, lines: [{ label: 'Instalment 1', amountPaise: 1000000 }] }],
      payments: [{ id: 'pay_1', receiptNumber: 'SDS/RCP/2026-27/0001', receivedOn: '2026-10-20', amountPaise: 400000, method: 'UPI', reversed: false }],
    }],
  };
  const open = (body, status = 200) => {
    globalThis.fetch = vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));
    render(<MemoryRouter initialEntries={['/f/abc']}><Routes><Route path="/f/:token" element={<ParentFees />} /></Routes></MemoryRouter>);
  };

  it('shows each child’s fees, receipts and how to pay, without a login', async () => {
    open(page);
    expect(await screen.findByRole('heading', { name: 'Sharma Classes' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Anaya Iyer' })).toHaveTextContent('Overdue');
    expect(screen.getByText('Pay by UPI to sharma@okhdfc')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invoice SDS/INV/2026-27/0001' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Receipt SDS/RCP/2026-27/0001' })).toBeInTheDocument();
    const [url, options] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('/api/auth/crm/public/fees?token=abc');
    expect(options.credentials).toBe('omit');
    expect(document.querySelector('meta[name="robots"]').content).toBe('noindex, nofollow');
  });

  it('explains an expired link in English and Hindi', async () => {
    open({ error: { code: 'link_expired' } }, 410);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This link has expired. Ask the class to send you a new one.');
    expect(alert).toHaveTextContent('इस लिंक की अवधि समाप्त हो गई है');
  });

  it('follows the class’s language', async () => {
    open({ ...page, language: 'hi' });
    expect(await screen.findByText('भुगतान कैसे करें')).toBeInTheDocument();
  });
});
