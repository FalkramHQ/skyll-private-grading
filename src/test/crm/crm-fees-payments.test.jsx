// Fees UI (CRM M2 phase 1 S3): Record payment with its allocation preview,
// reverse and move on the Fees card, Record payment from Dues, and Payments.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import FeesPage from '../../components/crm/fees/FeesPage';
import StudentFeesCard from '../../components/crm/fees/StudentFeesCard';

let calls;
let handlers;

function mockApi() {
  calls = [];
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const path = String(url).replace('/api/auth/crm/', '');
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method: options.method || 'GET', path, body, key: options.headers?.['Idempotency-Key'] });
    const handler = handlers.find(([match, method]) => path.startsWith(match) && (!method || method === (options.method || 'GET')));
    const [status, payload] = handler ? handler[2](body, path) : [200, { items: [], nextCursor: null }];
    return { ok: status < 400, status, json: async () => payload };
  });
}

const posts = (path) => calls.filter((call) => call.method === 'POST' && call.path === path).map((call) => call.body);
const me = (capabilities) => ({
  user: { id: 'usr_admin', role: 'admin' }, school: { id: 'sch_a', name: 'A', timezone: 'Asia/Kolkata' },
  capabilities, sections: ['fees', 'students'], support: false, taskScope: 'school', crmOnly: false,
});
const ADMIN = me(['crm.access', 'crm.finance.read', 'crm.finance.write', 'crm.students.read']);
const READER = me(['crm.access', 'crm.finance.read', 'crm.students.read']);
const student = { id: 'stu_1', name: 'Anaya Iyer', status: 'active' };

const invoice = (id, number, dueDate, totalPaise, paidPaise = 0, overdue = false) => ({
  id, number, student: { id: 'stu_1', name: 'Anaya Iyer' }, billedTo: 'Ravi Iyer', plan: null, status: 'issued', issueDate: '2026-10-01', dueDate,
  totalPaise, paidPaise, balancePaise: totalPaise - paidPaise, paymentStatus: paidPaise ? 'partly_paid' : 'unpaid', overdue, lines: [{ label: 'Fee', amountPaise: totalPaise }],
  voidReason: null, voidedAt: null, replacesInvoiceId: null,
});
const payment = {
  id: 'pay_1', receiptNumber: 'SDS/RCP/2026-27/0001', student: { id: 'stu_1', name: 'Anaya Iyer' }, amountPaise: 500000, receivedOn: '2026-10-10', method: 'cheque',
  reference: 'CHQ 004512', payerName: 'Ravi Iyer', note: 'Post-dated', recordedAt: '2026-10-10T05:00:00.000Z',
  allocations: [{ invoiceId: 'inv_1', invoiceNumber: 'SDS/INV/2026-27/0001', amountPaise: 400000 }], unallocatedPaise: 100000, reversal: null,
};
const fees = {
  student, billedTo: 'Ravi Iyer', today: '2026-10-14', courseIds: [],
  summary: { balancePaise: 2200000, overduePaise: 1000000, paidPaise: 400000, creditPaise: 100000, nextDue: { dueDate: '2026-06-15', amountPaise: 1000000 } },
  invoices: [invoice('inv_1', 'SDS/INV/2026-27/0001', '2026-06-15', 1400000, 400000, true), invoice('inv_2', 'SDS/INV/2026-27/0002', '2026-10-15', 1200000)],
  payments: [payment],
};

beforeEach(() => {
  handlers = [
    ['fees/student?', 'GET', () => [200, fees]],
    ['fees/payments/reverse', 'POST', () => [200, { ...payment, reversal: { reason: 'Cheque bounced' } }]],
    ['fees/allocations/move', 'POST', () => [200, payment]],
    ['fees/payments?', 'GET', () => [200, {
      from: '2026-09-14', to: '2026-10-14', today: '2026-10-14', truncated: false,
      items: [{ ...payment, receivedOn: '2026-10-14', reversal: { reason: 'Cheque bounced', at: 'x' } }, { ...payment, id: 'pay_2', receiptNumber: 'SDS/RCP/2026-27/0002', method: 'cash', reference: null, amountPaise: 150000 }],
      totals: { totalPaise: 150000, count: 1, byMethod: {} },
      todayTotals: { totalPaise: 350000, count: 2, byMethod: { cash: 100000, upi: 250000, bank_transfer: 0, cheque: 0, card: 0, other: 0 } },
    }]],
    ['fees/payments', 'POST', (body) => [201, {
      ...payment, id: 'pay_9', receiptNumber: 'SDS/RCP/2026-27/0009', amountPaise: body.amountPaise, method: body.method, receivedOn: body.receivedOn,
      allocations: body.allocations.map((item) => ({ ...item, invoiceNumber: item.invoiceId === 'inv_1' ? 'SDS/INV/2026-27/0001' : 'SDS/INV/2026-27/0002' })),
      unallocatedPaise: body.amountPaise - body.allocations.reduce((sum, item) => sum + item.amountPaise, 0),
    }]],
    ['fees/dues?', 'GET', () => [200, { today: '2026-10-14', items: fees.invoices, truncated: false, totals: { outstandingPaise: 2200000, overduePaise: 1000000, overdueStudents: 1 } }]],
  ];
  mockApi();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderCard = (user = ADMIN) => render(<MemoryRouter><StudentFeesCard student={student} me={user} /></MemoryRouter>);

describe('Record payment', () => {
  it('fills the oldest dues first, shows credit, and shows the receipt number', async () => {
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Record payment' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Amount (₹)'), { target: { value: '25,000' } });
    expect(within(dialog).getByLabelText('Amount for SDS/INV/2026-27/0001 (₹)')).toHaveValue('10000');
    expect(within(dialog).getByLabelText('Amount for SDS/INV/2026-27/0002 (₹)')).toHaveValue('12000');
    expect(within(dialog).getByText('₹22,000 to invoices · ₹3,000 becomes credit')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Method'), { target: { value: 'upi' } });
    fireEvent.change(within(dialog).getByLabelText('Reference (optional)'), { target: { value: 'UPI 7781' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record ₹25,000' }));
    await waitFor(() => expect(posts('fees/payments')).toHaveLength(1));
    expect(posts('fees/payments')[0]).toEqual({
      studentId: 'stu_1', amountPaise: 2500000, receivedOn: '2026-10-14', method: 'upi', reference: 'UPI 7781',
      allocations: [{ invoiceId: 'inv_1', amountPaise: 1000000 }, { invoiceId: 'inv_2', amountPaise: 1200000 }],
    });
    expect(await within(dialog).findByText('Receipt SDS/RCP/2026-27/0009')).toBeInTheDocument();
    expect(within(dialog).getByText('₹3,000 kept as credit')).toBeInTheDocument();
  });

  it('retries with the same key after a network failure, and a fresh key after a server error', async () => {
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Record payment' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Amount (₹)'), { target: { value: '1000' } });
    const real = globalThis.fetch;
    let attempt = 0;
    globalThis.fetch = vi.fn(async (url, options) => {
      attempt += 1;
      if (attempt === 1) { calls.push({ method: 'POST', path: 'fees/payments', key: options.headers['Idempotency-Key'] }); throw new TypeError('Failed to fetch'); }
      if (attempt === 2) { calls.push({ method: 'POST', path: 'fees/payments', key: options.headers['Idempotency-Key'] }); return { ok: false, status: 409, json: async () => ({ error: { code: 'balance_changed', message: 'Balances changed' } }) }; }
      return real(url, options);
    });
    const submit = () => fireEvent.click(within(dialog).getByRole('button', { name: 'Record ₹1,000' }));
    submit();
    await waitFor(() => expect(attempt).toBe(1));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Record ₹1,000' })).not.toBeDisabled());
    submit();
    expect(await within(dialog).findByText('Balances changed')).toBeInTheDocument();
    submit();
    expect(await within(dialog).findByText('Receipt SDS/RCP/2026-27/0009')).toBeInTheDocument();
    const keys = calls.filter((call) => call.method === 'POST' && call.path === 'fees/payments').map((call) => call.key);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('lets staff split by hand and blocks more than an invoice owes or a future date', async () => {
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Record payment' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Amount (₹)'), { target: { value: '5000' } });
    fireEvent.change(within(dialog).getByLabelText('Amount for SDS/INV/2026-27/0002 (₹)'), { target: { value: '13000' } });
    expect(within(dialog).getByText('An amount is more than that invoice owes.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Amount for SDS/INV/2026-27/0002 (₹)'), { target: { value: '2000' } });
    fireEvent.change(within(dialog).getByLabelText('Amount for SDS/INV/2026-27/0001 (₹)'), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText('Received on'), { target: { value: '2026-10-20' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record ₹5,000' }));
    expect(await within(dialog).findByText('Can\'t be in the future')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Received on'), { target: { value: '2026-10-13' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record ₹5,000' }));
    await waitFor(() => expect(posts('fees/payments')[0]).toMatchObject({ receivedOn: '2026-10-13', allocations: [{ invoiceId: 'inv_2', amountPaise: 200000 }] }));
  });

  it('opens from a Dues row for that student', async () => {
    render(<MemoryRouter initialEntries={['/crm/fees']}><Routes><Route path="/crm/fees" element={<FeesPage me={ADMIN} />} /></Routes></MemoryRouter>);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Record payment' }))[0]);
    expect(await screen.findByRole('dialog', { name: 'Record payment for Anaya Iyer' })).toBeInTheDocument();
  });
});

describe('Payments on the Fees card', () => {
  it('shows credit and payment details, and reverses with a reason', async () => {
    renderCard();
    expect(await screen.findByText('₹1,000')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /SDS\/RCP\/2026-27\/0001/ }));
    expect(screen.getByText('Paid by Ravi Iyer · Ref CHQ 004512')).toBeInTheDocument();
    expect(screen.getByText('Note: Post-dated')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reverse' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Cheque bounced' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reverse payment' }));
    await waitFor(() => expect(posts('fees/payments/reverse')).toEqual([{ paymentId: 'pay_1', reason: 'Cheque bounced' }]));
  });

  it('moves money from an invoice to another, never more than was allocated', async () => {
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /SDS\/RCP\/2026-27\/0001/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Move money' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Amount (₹)')).toHaveValue('4000');
    fireEvent.change(within(dialog).getByLabelText('To'), { target: { value: 'inv_2' } });
    fireEvent.change(within(dialog).getByLabelText('Amount (₹)'), { target: { value: '4500' } });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Meant for October' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(await within(dialog).findByText('At most ₹4,000')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Amount (₹)'), { target: { value: '1500' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(posts('fees/allocations/move')).toEqual([{
      paymentId: 'pay_1', fromInvoiceId: 'inv_1', toInvoiceId: 'inv_2', amountPaise: 150000, reason: 'Meant for October',
    }]));
  });

  it('downloads the receipt PDF with the school header and a readable file name', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:receipt');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    handlers.unshift(['fees/payments/receipt?', 'GET', () => [200, {}]]);
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, options) => {
      const response = await fetchBefore(url, options);
      return { ...response, blob: async () => new Blob(['%PDF-']) };
    });
    renderCard(READER);
    fireEvent.click(await screen.findByRole('button', { name: /SDS\/RCP\/2026-27\/0001/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Receipt PDF' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(calls.at(-1).path).toBe('fees/payments/receipt?paymentId=pay_1');
    expect(click.mock.instances[0].download).toBe('SDS-RCP-2026-27-0001.pdf');
  });

  it('hides payment actions without finance write', async () => {
    renderCard(READER);
    fireEvent.click(await screen.findByRole('button', { name: /SDS\/RCP\/2026-27\/0001/ }));
    expect(screen.queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
  });
});

describe('Fees → Payments', () => {
  it('shows today\'s collection by method and strikes through reversed payments', async () => {
    render(<MemoryRouter initialEntries={['/crm/fees?tab=payments']}><Routes><Route path="/crm/fees" element={<FeesPage me={READER} />} /></Routes></MemoryRouter>);
    expect(await screen.findByText('₹3,500')).toBeInTheDocument();
    expect(screen.getByText('UPI', { selector: 'dt' })).toBeInTheDocument();
    expect(screen.getByText('SDS/RCP/2026-27/0001')).toHaveClass('line-through');
    expect(screen.getByText('Reversed')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'cash' } });
    await waitFor(() => expect(calls.filter((call) => call.path.startsWith('fees/payments?')).at(-1).path).toContain('method=cash'));
  });
});
