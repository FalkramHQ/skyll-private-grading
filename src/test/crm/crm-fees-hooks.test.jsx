// Fees journey hooks (CRM M2 phase 1 S5, D9): the "Set up fees" offer, the
// stop-future prompt for inactive students, and the sibling dues hint.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
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

const me = (capabilities) => ({
  user: { id: 'usr_admin', role: 'admin' }, school: { id: 'sch_a', name: 'A', timezone: 'Asia/Kolkata' },
  capabilities, sections: ['fees', 'students'], support: false, taskScope: 'school', crmOnly: false,
});
const ADMIN = me(['crm.access', 'crm.finance.read', 'crm.finance.write', 'crm.students.read', 'crm.contacts.read']);
const invoice = {
  id: 'inv_1', number: 'SDS/INV/2026-27/0001', student: { id: 'stu_1', name: 'Anaya Iyer' }, billedTo: null, plan: null, status: 'issued', issueDate: '2026-10-14',
  dueDate: '2026-11-05', totalPaise: 250000, paidPaise: 0, balancePaise: 250000, paymentStatus: 'unpaid', overdue: false, lines: [{ label: 'Tuition', amountPaise: 250000 }],
  voidReason: null, voidedAt: null, replacesInvoiceId: null,
};
const fees = (student, extra = {}) => ({
  student, billedTo: null, today: '2026-10-14', courseIds: [], payments: [], siblings: [], invoices: [],
  summary: { balancePaise: 0, overduePaise: 0, paidPaise: 0, creditPaise: 0, nextDue: null }, ...extra,
});

let current;
beforeEach(() => {
  current = fees({ id: 'stu_1', name: 'Anaya Iyer', status: 'active' });
  handlers = [
    ['fees/student?', 'GET', () => [200, current]],
    ['fees/plans?', 'GET', () => [200, { items: [], nextCursor: null }]],
    ['fees/invoices/stop-future', 'POST', () => [200, { voided: 1, skipped: 0 }]],
  ];
  mockApi();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}{location.search}</p>;
}

function renderCard(student, entry = '/crm/students/stu_1') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes><Route path="/crm/students/:id" element={<><StudentFeesCard student={student} me={ADMIN} /><Where /></>} /></Routes>
    </MemoryRouter>,
  );
}

describe('Fees journey hooks', () => {
  it('offers fee set-up after conversion or a batch add, never on its own', async () => {
    renderCard(current.student, '/crm/students/stu_1?fees=setup');
    expect(await screen.findByText('Set up fees for Anaya Iyer?')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set up fees' }));
    expect(await screen.findByRole('dialog', { name: 'Add fees for Anaya Iyer' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/crm/students/stu_1');
    expect(screen.getByTestId('where')).not.toHaveTextContent('fees=setup');
  });

  it('can be dismissed, and is not offered without the link', async () => {
    renderCard(current.student, '/crm/students/stu_1?fees=setup');
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByText(/Set up fees for/)).not.toBeInTheDocument());
    cleanup();
    renderCard(current.student);
    await screen.findByText('No fees yet. Use Add fees to bill this student from a fee plan.');
    expect(screen.queryByText(/Set up fees for/)).not.toBeInTheDocument();
  });

  it('asks to stop future fees when an inactive student still has some', async () => {
    current = fees({ id: 'stu_1', name: 'Anaya Iyer', status: 'inactive' }, { invoices: [invoice] });
    renderCard(current.student);
    expect(await screen.findByText(/is no longer active but has 1 unpaid invoice due from today/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add fees' })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop future fees' })[0]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Left the institute' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Void 1 invoice' }));
    await waitFor(() => expect(calls.some((call) => call.path === 'fees/invoices/stop-future')).toBe(true));
  });

  it('mentions siblings who owe fees through a shared guardian', async () => {
    current = fees(current.student, { siblings: [{ studentId: 'stu_2', name: 'Arjun Sharma', guardianName: 'Meera Iyer', balancePaise: 150000 }] });
    renderCard(current.student);
    expect(await screen.findByText(/Meera Iyer is also guardian of/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Arjun Sharma' })).toHaveAttribute('href', '/crm/students/stu_2');
    expect(screen.getByText(/₹1,500 due/)).toBeInTheDocument();
  });
});
