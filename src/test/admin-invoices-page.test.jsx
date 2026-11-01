import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminInvoices from '../pages/AdminInvoices';

// The page reads the signed-in role through useSession. Answer from the role
// each test sets, so no test depends on session state another test left behind.
vi.mock('../lib/auth', () => ({
  useSession: () => ({
    user: { username: 'tester', role: localStorage.getItem('userRole'), school: localStorage.getItem('userSchool') },
    loading: false,
  }),
}));

const STATES = ['Karnataka', 'Maharashtra'];
const profilesPayload = {
  states: STATES,
  schools: [
    { id: 'sch_a', slug: 'alpha', name: 'Alpha Classes', status: 'active', profile: null, complete: false },
    { id: 'sch_b', slug: 'beta', name: 'Beta Institute', status: 'active', complete: true,
      profile: { schoolId: 'sch_b', legalName: 'Beta Institute LLP', address: 'Bengaluru', gstin: '29ABCDE1234F1Z5', pan: null, placeOfSupply: 'Karnataka' } },
  ],
};
const LINES = [{ examId: 'ex_1', examName: 'Physics Unit 1', examDate: '2026-09-05', maxMarks: 100, papers: 4935, ratePaisePerMark: 25, amountPaise: 12337500 }];
const INVOICE = {
  id: 'inv_1', schoolId: 'sch_b', school: 'Beta Institute', period: '2026-09', number: 'SKY/2026-27/0001', status: 'issued', invoiceDate: '2026-10-02',
  paperCount: 4935, subtotalPaise: 12337500, roundOffPaise: 0, totalPaise: 12337500, issuedBy: 'sky_admin', paidOn: null, paidReference: null,
  billTo: { legalName: 'Beta Institute LLP', address: 'Bengaluru', gstin: null, pan: null, placeOfSupply: 'Karnataka' },
  lines: LINES, papers: [{ submissionId: 'sub_1', examId: 'ex_1', studentName: 'Bela', maxMarks: 100, amountPaise: 2500 }],
};

/** routes: { 'GET /api/auth/invoices': payload | fn, 'POST preview': payload | fn, ... } */
function mockFetch(routes) {
  const fetchMock = vi.fn(async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const key = url.startsWith('/api/auth/billing-profiles') ? (options.method === 'PUT' ? 'PUT profiles' : 'GET profiles')
      : url.includes('format=pdf') ? 'GET pdf'
        : url.startsWith('/api/auth/invoices?id=') ? 'GET invoice'
        : url.startsWith('/api/auth/invoices') ? (body ? `POST ${body.action}` : 'GET invoices') : null;
    if (!key || !(key in routes)) throw new Error(`Unexpected fetch ${options.method || 'GET'} ${url}`);
    const payload = typeof routes[key] === 'function' ? routes[key](body) : routes[key];
    const status = payload?.httpStatus || 200;
    return { ok: status < 400, status, json: async () => payload, blob: async () => new Blob(['%PDF-1.7'], { type: 'application/pdf' }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const BASE = { 'GET profiles': profilesPayload, 'GET invoices': { invoices: [], unpaid: [] } };

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-07T06:00:00.000Z')); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('admin invoices page — billing profiles (FLKRM-485)', () => {
  it('shows every school with its profile status', async () => {
    localStorage.setItem('userRole', 'skyll_admin');
    mockFetch(BASE);
    render(<MemoryRouter><AdminInvoices /></MemoryRouter>);
    const alpha = (await screen.findByText('Alpha Classes', { selector: 'td' })).closest('tr');
    expect(within(alpha).getByText('Missing')).toBeInTheDocument();
    const beta = screen.getByText('Beta Institute', { selector: 'td' }).closest('tr');
    expect(within(beta).getByText('Complete')).toBeInTheDocument();
    expect(within(beta).getByText('29ABCDE1234F1Z5')).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 schools set up/)).toBeInTheDocument();
  });

  it('adds a profile through the dialog and marks the school complete', async () => {
    localStorage.setItem('userRole', 'skyll_admin');
    const fetchMock = mockFetch({ ...BASE, 'PUT profiles': { complete: true, profile: { schoolId: 'sch_a', legalName: 'Alpha Classes Pvt Ltd', address: 'Pune', gstin: null, pan: null, placeOfSupply: 'Maharashtra' } } });
    render(<MemoryRouter><AdminInvoices /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit billing profile for Alpha Classes' }));
    fireEvent.change(await screen.findByLabelText('Legal name'), { target: { value: 'Alpha Classes Pvt Ltd' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'Pune' } });
    fireEvent.change(screen.getByLabelText('Place of supply'), { target: { value: 'Maharashtra' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/billing-profiles', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ schoolId: 'sch_a', legalName: 'Alpha Classes Pvt Ltd', address: 'Pune', gstin: '', pan: '', placeOfSupply: 'Maharashtra', bands: [] }),
    })));
    const alpha = (await screen.findByText('Alpha Classes Pvt Ltd')).closest('tr');
    expect(within(alpha).getByText('Complete')).toBeInTheDocument();
  });

  it('does not load anything for a school admin', async () => {
    localStorage.setItem('userRole', 'admin');
    const fetchMock = mockFetch(BASE);
    render(<MemoryRouter><AdminInvoices /></MemoryRouter>);
    expect(screen.getByText('Invoices are available to platform admins only.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('admin invoices page — invoices (FLKRM-486)', () => {
  it('offers only profiled schools and completed months, previews, then generates', async () => {
    localStorage.setItem('userRole', 'skyll_admin');
    const fetchMock = mockFetch({
      ...BASE,
      'POST preview': { preview: { school: 'Beta Institute', period: '2026-09', paperCount: 4935, lines: LINES, subtotalPaise: 12337500, roundOffPaise: 0, totalPaise: 12337500, canGenerate: true, blocker: null } },
      'POST generate': { invoice: INVOICE },
      'GET invoice': { invoice: INVOICE },
    });
    render(<MemoryRouter><AdminInvoices /></MemoryRouter>);
    const schoolSelect = await screen.findByLabelText('School', { selector: '#invoice-school' });
    await waitFor(() => expect(within(schoolSelect).getAllByRole('option').map((o) => o.textContent)).toEqual(['Select a school', 'Beta Institute']));
    const monthSelect = screen.getByLabelText('Month');
    expect(within(monthSelect).getAllByRole('option').map((o) => o.textContent)).toEqual(['October 2026 (in progress)', 'September 2026']);
    expect(monthSelect).toHaveValue('2026-09');

    fireEvent.change(schoolSelect, { target: { value: 'sch_b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByTestId('invoice-total')).toHaveTextContent('₹1,23,375.00');
    fireEvent.click(screen.getByRole('button', { name: 'Generate invoice' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/invoices', expect.objectContaining({ body: JSON.stringify({ action: 'generate', schoolId: 'sch_b', period: '2026-09' }) })));
    expect(await screen.findByRole('heading', { name: 'SKY/2026-27/0001' })).toBeInTheDocument();
  });

  it('shows why a month cannot be generated', async () => {
    localStorage.setItem('userRole', 'skyll_admin');
    mockFetch({ ...BASE, 'POST preview': { preview: { school: 'Beta Institute', period: '2026-09', paperCount: 0, lines: [], subtotalPaise: 0, roundOffPaise: 0, totalPaise: 0, canGenerate: false, blocker: { code: 'already_invoiced', message: 'SKY/2026-27/0001 is already issued for this month. Void it to reissue.' } } } });
    render(<MemoryRouter><AdminInvoices /></MemoryRouter>);
    const schoolSelect = await screen.findByLabelText('School', { selector: '#invoice-school' });
    await waitFor(() => expect(within(schoolSelect).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(schoolSelect, { target: { value: 'sch_b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(/already issued for this month/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate invoice' })).toBeDisabled();
  });

  it('lists invoices with unpaid totals, marks one paid and blocks voiding while paid', async () => {
    localStorage.setItem('userRole', 'skyll_admin');
    const fetchMock = mockFetch({
      ...BASE,
      'GET invoices': { invoices: [INVOICE], unpaid: [{ schoolId: 'sch_b', school: 'Beta Institute', invoices: 1, totalPaise: 12337500 }] },
      'GET invoice': { invoice: INVOICE },
      'POST mark-paid': { invoice: { ...INVOICE, paidOn: '2026-10-07', paidReference: 'UTR9', paidMarkedBy: 'sky_admin' } },
    });
    render(<MemoryRouter><AdminInvoices /></MemoryRouter>);
    expect(await screen.findByLabelText('Unpaid totals')).toHaveTextContent('Beta Institute · 1 unpaid₹1,23,375.00');
    fireEvent.click(screen.getByRole('button', { name: 'Open SKY/2026-27/0001' }));
    expect(await screen.findByText('Billed papers (1)')).toBeInTheDocument();
    expect(screen.getByLabelText('Paid on')).toHaveValue('2026-10-07');
    fireEvent.change(screen.getByLabelText(/Reference/), { target: { value: 'UTR9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark paid' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/invoices', expect.objectContaining({ body: JSON.stringify({ action: 'mark-paid', invoiceId: 'inv_1', paidOn: '2026-10-07', reference: 'UTR9' }) })));
    expect(await screen.findByText(/Paid on 7 Oct 2026 · ref UTR9/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Void invoice' })).toBeDisabled();
    expect(screen.getByText('Remove the paid mark before voiding.')).toBeInTheDocument();
  });

  it('downloads the PDF, and explains when PDFs are not configured', async () => {
    localStorage.setItem('userRole', 'skyll_admin');
    let pdfStatus = 200;
    const fetchMock = mockFetch({
      ...BASE,
      'GET invoices': { invoices: [INVOICE], unpaid: [] },
      'GET invoice': { invoice: INVOICE },
      'GET pdf': () => (pdfStatus === 200 ? {} : { httpStatus: 503, code: 'pdf_not_configured', error: "The invoice signature isn't uploaded (expected a PNG at billing/invoice-signature.png in private storage). Run scripts/uploadInvoiceSignature.mjs." }),
    });
    const createObjectURL = vi.fn(() => 'blob:invoice');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<MemoryRouter><AdminInvoices /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Download SKY/2026-27/0001 PDF' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/invoices?id=inv_1&format=pdf', expect.anything());
    expect(createObjectURL).toHaveBeenCalled();
    expect(click.mock.contexts[0].download).toBe('SKY-2026-27-0001.pdf');

    pdfStatus = 503;
    fireEvent.click(screen.getByRole('button', { name: 'Open SKY/2026-27/0001' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download SKY/2026-27/0001 PDF' }));
    expect(await within(dialog).findByText(/signature isn't uploaded/)).toBeInTheDocument();
    click.mockRestore();
  });

  it('edits price bands in the billing profile and tags custom pricing (#311)', async () => {
    localStorage.setItem('userRole', 'skyll_admin');
    const fetchMock = mockFetch({
      ...BASE,
      'PUT profiles': (body) => ({ complete: true, profile: { schoolId: 'sch_b', legalName: 'Beta Institute LLP', address: 'Bengaluru', gstin: '29ABCDE1234F1Z5', pan: null, placeOfSupply: 'Karnataka' }, bands: body.bands }),
    });
    render(<MemoryRouter><AdminInvoices /></MemoryRouter>);
    const beta = (await screen.findByText('Beta Institute', { selector: 'td' })).closest('tr');
    expect(within(beta).getByText('₹0.25/mark')).toBeInTheDocument();
    fireEvent.click(within(beta).getByRole('button', { name: 'Edit billing profile for Beta Institute' }));
    expect(await screen.findByText(/Default: ₹0.25 per mark/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add band' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add band' }));
    fireEvent.change(screen.getByLabelText('Up to (marks)', { selector: '#band-marks-0' }), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText('Price per paper (₹)', { selector: '#band-price-0' }), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Up to (marks)', { selector: '#band-marks-1' }), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Price per paper (₹)', { selector: '#band-price-1' }), { target: { value: '22.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/billing-profiles', expect.objectContaining({ method: 'PUT' })));
    const put = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT');
    expect(JSON.parse(put[1].body).bands).toEqual([{ maxMarks: 40, pricePaise: 1000 }, { maxMarks: 100, pricePaise: 2250 }]);
    expect(await within(screen.getByText('Beta Institute', { selector: 'td' }).closest('tr')).findByText('Custom pricing')).toBeInTheDocument();
  });

  it('refuses a half-filled price band before saving', async () => {
    localStorage.setItem('userRole', 'skyll_admin');
    const fetchMock = mockFetch(BASE);
    render(<MemoryRouter><AdminInvoices /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit billing profile for Beta Institute' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add band' }));
    fireEvent.change(screen.getByLabelText('Up to (marks)', { selector: '#band-marks-0' }), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Each price band needs both a marks limit and a price.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
  });
});
