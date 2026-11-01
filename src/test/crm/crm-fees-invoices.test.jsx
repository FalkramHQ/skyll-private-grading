// Fees UI (CRM M2 phase 1 S2): the student's Fees card, Add fees with a
// preview and per-student edits, correct / void / stop future, and Dues.
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
    calls.push({ method: options.method || 'GET', path, body });
    const handler = handlers.find(([match, method]) => path.startsWith(match) && (!method || method === (options.method || 'GET')));
    const [status, payload] = handler ? handler[2](body, path) : [200, { items: [], nextCursor: null }];
    return { ok: status < 400, status, json: async () => payload };
  });
}

const posts = (path) => calls.filter((call) => call.method === 'POST' && call.path === path).map((call) => call.body);
const gets = (prefix) => calls.filter((call) => call.method === 'GET' && call.path.startsWith(prefix)).map((call) => call.path);

function me(capabilities) {
  return {
    user: { id: 'usr_admin', role: 'admin' }, school: { id: 'sch_a', name: 'A', timezone: 'Asia/Kolkata' },
    capabilities, sections: ['fees', 'students'], support: false, taskScope: 'school', crmOnly: false,
  };
}
const ADMIN = me(['crm.access', 'crm.finance.read', 'crm.finance.write', 'crm.classes.read', 'crm.students.read']);
const READER = me(['crm.access', 'crm.finance.read', 'crm.students.read']);
const student = { id: 'stu_1', name: 'Anaya Iyer', status: 'active' };

const invoice = (extra) => ({
  id: 'inv_1', number: 'SDS/INV/2026-27/0001', student: { id: 'stu_1', name: 'Anaya Iyer' }, billedTo: 'Ravi Iyer', plan: { id: 'fplan_1', name: 'Grade 10 Maths tuition' },
  status: 'issued', issueDate: '2026-10-14', dueDate: '2026-06-15', totalPaise: 1400000, paidPaise: 0, paymentStatus: 'unpaid', balancePaise: 1400000, overdue: true,
  lines: [{ label: 'Admission fee', amountPaise: 200000 }, { label: 'Instalment 1', amountPaise: 1200000 }], voidReason: null, voidedAt: null, replacesInvoiceId: null,
  ...extra,
});
const fees = {
  student, billedTo: 'Ravi Iyer', today: '2026-10-14', courseIds: ['course_1'], payments: [],
  summary: { balancePaise: 2600000, overduePaise: 1400000, paidPaise: 0, creditPaise: 0, nextDue: { dueDate: '2026-06-15', amountPaise: 1400000 } },
  invoices: [
    invoice(),
    invoice({ id: 'inv_2', number: 'SDS/INV/2026-27/0002', dueDate: '2026-10-15', totalPaise: 1200000, balancePaise: 1200000, overdue: false, lines: [{ label: 'Instalment 2', amountPaise: 1200000 }] }),
    invoice({ id: 'inv_0', number: 'SDS/INV/2026-27/0000', status: 'void', paymentStatus: 'void', balancePaise: 0, overdue: false, voidReason: 'Duplicate' }),
  ],
};
const plans = [
  { id: 'fplan_1', name: 'Grade 10 Maths tuition', course: { id: 'course_1', name: 'Grade 10 Maths' }, totalPaise: 3800000 },
  { id: 'fplan_2', name: 'Foundation Science monthly', course: null, totalPaise: 2650000 },
];
const preview = {
  student, plan: { id: 'fplan_1', name: 'Grade 10 Maths tuition', status: 'active' }, startDate: '2026-06-15', startSource: 'batch', batchName: 'Grade 10 Maths Evening',
  billedTo: 'Ravi Iyer', alreadyFromPlan: 0,
  invoices: [
    { dueDate: '2026-06-15', lines: [{ label: 'Admission fee', amountPaise: 200000 }, { label: 'Instalment 1', amountPaise: 1200000 }], totalPaise: 1400000 },
    { dueDate: '2026-10-15', lines: [{ label: 'Instalment 2', amountPaise: 1200000 }], totalPaise: 1200000 },
  ],
};

beforeEach(() => {
  handlers = [
    ['fees/student?', 'GET', () => [200, fees]],
    ['fees/plans?', 'GET', () => [200, { items: plans, nextCursor: null }]],
    ['fees/preview?', 'GET', () => [200, preview]],
    ['fees/apply', 'POST', () => [201, { items: [] }]],
    ['fees/invoices/void', 'POST', () => [200, invoice({ status: 'void' })]],
    ['fees/invoices/correct', 'POST', () => [201, invoice()]],
    ['fees/invoices/stop-future', 'POST', () => [200, { voided: 1, skipped: 0 }]],
    ['fees/invoices', 'POST', () => [201, invoice()]],
    ['fees/dues?', 'GET', () => [200, { today: '2026-10-14', items: fees.invoices.slice(0, 2), truncated: false, totals: { outstandingPaise: 2600000, overduePaise: 1400000, overdueStudents: 1 } }]],
    ['classes/batches?', 'GET', () => [200, { items: [{ id: 'b_1', name: 'Grade 10 Maths Evening' }], nextCursor: null }]],
    ['classes/courses?', 'GET', () => [200, { items: [{ id: 'course_1', name: 'Grade 10 Maths' }], nextCursor: null }]],
  ];
  mockApi();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderCard = (user = ADMIN) => render(<MemoryRouter><StudentFeesCard student={student} me={user} /></MemoryRouter>);

describe('Student Fees card', () => {
  it('shows balance, overdue and invoices, hiding void ones until asked', async () => {
    renderCard();
    expect(await screen.findByText('₹26,000')).toBeInTheDocument();
    expect(screen.getAllByText('₹14,000').length).toBeGreaterThan(0);
    expect(screen.getByText('SDS/INV/2026-27/0001')).toBeInTheDocument();
    expect(screen.getByText('Overdue', { selector: 'div' })).toBeInTheDocument();
    expect(screen.queryByText('SDS/INV/2026-27/0000')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 void invoice' }));
    expect(screen.getByText('SDS/INV/2026-27/0000')).toBeInTheDocument();
  });

  it('adds fees from the suggested plan, with the batch start and per-student edits', async () => {
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Add fees' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(gets('fees/preview')).toHaveLength(1));
    expect(gets('fees/preview')[0]).toContain('planId=fplan_1');
    expect(await within(dialog).findByText(/when Grade 10 Maths Evening started/)).toBeInTheDocument();
    expect(within(dialog).getByText('₹26,000')).toBeInTheDocument();

    // Choosing the same plan again keeps the preview.
    fireEvent.change(within(dialog).getByLabelText('Fee plan'), { target: { value: 'fplan_1' } });
    expect(within(dialog).getByText('₹26,000')).toBeInTheDocument();
    fireEvent.change(within(dialog).getAllByLabelText('Amount 1 (₹)')[1], { target: { value: '10000' } });
    fireEvent.change(within(dialog).getByLabelText('Due', { selector: '#add-fees-due-1' }), { target: { value: '2026-10-22' } });
    expect(within(dialog).getByText('₹24,000')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Issue 2 invoices' }));
    await waitFor(() => expect(posts('fees/apply')).toHaveLength(1));
    expect(posts('fees/apply')[0]).toEqual({
      studentId: 'stu_1', planId: 'fplan_1', startDate: '2026-06-15',
      invoices: [
        { dueDate: '2026-06-15', lines: [{ label: 'Admission fee', amountPaise: 200000 }, { label: 'Instalment 1', amountPaise: 1200000 }] },
        { dueDate: '2026-10-22', lines: [{ label: 'Instalment 2', amountPaise: 1000000 }] },
      ],
    });
    expect(gets('fees/preview')).toHaveLength(1);
  });

  it('re-previews when the start date changes and warns about a plan already applied', async () => {
    handlers.unshift(['fees/preview?', 'GET', (_, path) => [200, { ...preview, alreadyFromPlan: 2, startSource: path.includes('startDate') ? 'chosen' : 'batch', startDate: path.includes('startDate') ? '2026-11-01' : preview.startDate }]]);
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Add fees' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/already has 2 invoices from this plan/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Start date'), { target: { value: '2026-11-01' } });
    await waitFor(() => expect(gets('fees/preview')).toHaveLength(2));
    expect(gets('fees/preview')[1]).toContain('startDate=2026-11-01');
  });

  it('corrects and voids an invoice with a reason, and stops future fees', async () => {
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /SDS\/INV\/2026-27\/0001/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Void' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Void invoice' }));
    expect(await within(dialog).findByText(/at least 3 characters/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Duplicate invoice' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Void invoice' }));
    await waitFor(() => expect(posts('fees/invoices/void')).toEqual([{ invoiceId: 'inv_1', reason: 'Duplicate invoice' }]));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /SDS\/INV\/2026-27\/0002/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Correct' }).at(-1));
    dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Amount 1 (₹)'), { target: { value: '11000' } });
    fireEvent.change(within(dialog).getByLabelText('Reason for the correction'), { target: { value: 'Discount agreed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Void and re-issue' }));
    await waitFor(() => expect(posts('fees/invoices/correct')).toEqual([{
      invoiceId: 'inv_2', reason: 'Discount agreed', dueDate: '2026-10-15', lines: [{ label: 'Instalment 2', amountPaise: 1100000 }],
    }]));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Stop future fees' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('1 invoice, ₹12,000')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Left the institute' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Void 1 invoice' }));
    await waitFor(() => expect(posts('fees/invoices/stop-future')).toEqual([{ studentId: 'stu_1', fromDate: '2026-10-14', reason: 'Left the institute' }]));
  });

  it('is read-only without finance write', async () => {
    renderCard(READER);
    expect(await screen.findByText('SDS/INV/2026-27/0001')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add fees' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /SDS\/INV\/2026-27\/0001/ }));
    expect(screen.queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop future fees' })).not.toBeInTheDocument();
  });
});

describe('Fees → Dues', () => {
  it('shows totals and filters by due window and batch through the URL', async () => {
    render(<MemoryRouter initialEntries={['/crm/fees']}><Routes><Route path="/crm/fees" element={<FeesPage me={ADMIN} />} /></Routes></MemoryRouter>);
    expect(await screen.findByText('₹14,000', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('1 student')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Anaya Iyer' })[0]).toHaveAttribute('href', '/crm/students/stu_1');
    fireEvent.click(screen.getByRole('button', { name: 'Overdue' }));
    await waitFor(() => expect(gets('fees/dues').at(-1)).toContain('filter=overdue'));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Grade 10 Maths Evening' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Batch'), { target: { value: 'b_1' } });
    await waitFor(() => expect(gets('fees/dues').at(-1)).toContain('batchId=b_1'));
  });
});
