// Fees UI (CRM M2 phase 1 S1): fee plans list, the plan form with its live
// total and sample schedule, and Settings → Fees.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import FeesPage from '../../components/crm/fees/FeesPage';
import FeeSettings from '../../components/crm/FeeSettings';

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

function me(capabilities) {
  return {
    user: { id: 'usr_admin', role: 'admin' }, school: { id: 'sch_a', name: 'A', timezone: 'Asia/Kolkata' },
    capabilities, sections: ['fees'], support: false, taskScope: 'school', crmOnly: false,
  };
}
const ADMIN = me(['crm.access', 'crm.finance.read', 'crm.finance.write', 'crm.classes.read', 'crm.settings.manage']);
const READER = me(['crm.access', 'crm.finance.read']);

const plan = {
  id: 'fplan_1', name: 'Grade 10 Maths tuition', course: { id: 'course_1', name: 'Grade 10 Maths' }, kind: 'instalments',
  items: [
    { id: 'fpi_1', label: 'Admission fee', amountPaise: 200000, dueOffsetValue: 0, dueOffsetUnit: 'days' },
    { id: 'fpi_2', label: 'Instalment 1', amountPaise: 1200000, dueOffsetValue: 0, dueOffsetUnit: 'months' },
    { id: 'fpi_3', label: 'Instalment 2', amountPaise: 1200000, dueOffsetValue: 4, dueOffsetUnit: 'months' },
  ],
  monthly: null, description: null, status: 'active', version: 1, totalPaise: 2600000,
};

beforeEach(() => {
  handlers = [
    ['fees/plans/archive', 'POST', () => [200, { ...plan, status: 'archived', version: 2 }]],
    ['fees/plans?', 'GET', () => [200, { items: [plan], nextCursor: null }]],
    ['fees/plans', 'POST', (body) => [201, { ...plan, ...body, id: 'fplan_new' }]],
    ['classes/courses?', 'GET', () => [200, { items: [{ id: 'course_1', name: 'Grade 10 Maths' }], nextCursor: null }]],
    ['settings/fees', 'GET', () => [200, { prefix: 'SDS', headerName: 'Skyll Demo School', headerAddress: '', headerPhone: '', headerGstin: '', footerNote: '', version: 0, saved: false }]],
    ['settings/fees', 'POST', (body) => [200, { ...body, version: 1, saved: true }]],
  ];
  mockApi();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderFees(user, entry = '/crm/fees?tab=plans') {
  return render(<MemoryRouter initialEntries={[entry]}><Routes><Route path="/crm/fees" element={<FeesPage me={user} />} /></Routes></MemoryRouter>);
}

describe('Fees → Fee plans', () => {
  it('lists plans with course, total and when each charge is due', async () => {
    renderFees(ADMIN);
    expect(await screen.findByText('Grade 10 Maths tuition')).toBeInTheDocument();
    expect(screen.getByText('Course: Grade 10 Maths · ₹26,000 in total')).toBeInTheDocument();
    expect(screen.getByText('4 months after start')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(posts('fees/plans/archive')).toEqual([{ planId: 'fplan_1', expectedVersion: 1 }]));
  });

  it('creates an instalment plan in rupees, showing the total and a sample schedule', async () => {
    renderFees(ADMIN);
    fireEvent.click(await screen.findByRole('button', { name: 'New fee plan' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Plan name'), { target: { value: 'Grade 9 Science' } });
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Grade 10 Maths' })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText('Course (optional)'), { target: { value: 'course_1' } });
    fireEvent.change(within(dialog).getByLabelText('Amount (₹)'), { target: { value: '2,000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add a charge' }));
    const amounts = within(dialog).getAllByLabelText('Amount (₹)');
    fireEvent.change(amounts[1], { target: { value: '12000.50' } });
    fireEvent.change(within(dialog).getAllByLabelText('Due')[1], { target: { value: '3' } });
    expect(within(dialog).getByText('₹14,000.50')).toBeInTheDocument();
    expect(within(dialog).getByText(/If the fees started on/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create plan' }));
    await waitFor(() => expect(posts('fees/plans')).toHaveLength(1));
    expect(posts('fees/plans')[0]).toMatchObject({
      name: 'Grade 9 Science', courseId: 'course_1', kind: 'instalments', monthly: null,
      items: [
        { label: 'Admission fee', amountPaise: 200000, dueOffsetValue: 0, dueOffsetUnit: 'months' },
        { label: 'Instalment 1', amountPaise: 1200050, dueOffsetValue: 3, dueOffsetUnit: 'months' },
      ],
    });
  });

  it('needs monthly fee details for a monthly plan and blocks bad amounts', async () => {
    renderFees(ADMIN);
    fireEvent.click(await screen.findByRole('button', { name: 'New fee plan' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Plan name'), { target: { value: 'Monthly' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Monthly' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Admission fee' }));
    fireEvent.change(within(dialog).getByLabelText('Amount each month (₹)'), { target: { value: 'abc' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create plan' }));
    expect(await within(dialog).findByText('Enter an amount')).toBeInTheDocument();
    expect(posts('fees/plans')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText('Amount each month (₹)'), { target: { value: '2500' } });
    fireEvent.change(within(dialog).getByLabelText('Number of months'), { target: { value: '10' } });
    expect(within(dialog).getByText('₹25,000')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create plan' }));
    await waitFor(() => expect(posts('fees/plans')[0]).toMatchObject({ kind: 'monthly', items: [], monthly: { amountPaise: 250000, count: 10, dueDay: 5 } }));
  });

  it('shows plans read-only without finance write', async () => {
    renderFees(READER);
    expect(await screen.findByText('Grade 10 Maths tuition')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New fee plan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});

describe('Settings → Fees', () => {
  it('prefills from the school, previews numbering and saves', async () => {
    render(<FeeSettings timezone="Asia/Kolkata" />);
    expect(await screen.findByText(/Filled in from your school's details/)).toBeInTheDocument();
    expect(screen.getByText(/Invoices will be numbered SDS\/INV\/\d{4}-\d{2}\/0001/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Number prefix'), { target: { value: 'sd-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('2–8 capital letters or digits')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Number prefix'), { target: { value: 'skd' } });
    fireEvent.change(screen.getByLabelText('Footer note (optional)'), { target: { value: 'Fees are non-refundable.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts('settings/fees')).toEqual([{
      prefix: 'SKD', headerName: 'Skyll Demo School', headerAddress: '', headerPhone: '', headerGstin: '', footerNote: 'Fees are non-refundable.', expectedVersion: 0,
    }]));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
  });
});
