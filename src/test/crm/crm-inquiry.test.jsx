// Inquiry form settings and the public inquiry page (FLKRM-326 S6).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import InquirySettings from '../../components/crm/InquirySettings';
import PublicInquiry from '../../pages/PublicInquiry';

let calls;
let handlers;

function mockApi() {
  calls = [];
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const path = String(url).replace('/api/auth/crm/', '');
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method: options.method || 'GET', path, body, headers: options.headers });
    const handler = handlers.find(([match, method]) => path.startsWith(match) && method === (options.method || 'GET'));
    const [status, payload] = handler ? handler[2](body) : [404, { error: { code: 'not_found', message: 'Not found' } }];
    return { ok: status < 400, status, json: async () => payload };
  });
}
const posts = (path) => calls.filter((call) => call.method === 'POST' && call.path.startsWith(path)).map((call) => call.body);

beforeEach(() => { handlers = []; mockApi(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });

describe('Inquiry form settings', () => {
  const owners = [{ userId: 'usr_admin', name: 'Admin A', role: 'admin' }, { userId: 'usr_staff', name: 'Front Desk', role: 'staff' }];
  const settings = (overrides = {}) => ({ enabled: false, defaultOwnerUserId: null, ownerEligible: false, owners, publicPath: '/inquire/school-a', version: 0, ...overrides });

  it('needs an owner before turning the form on, then shows the link to share', async () => {
    handlers.push(
      ['settings/inquiry', 'GET', () => [200, settings()]],
      ['settings/inquiry', 'POST', (body) => [200, settings({ enabled: body.enabled, defaultOwnerUserId: body.defaultOwnerUserId, ownerEligible: true, version: 1 })]],
    );
    render(<InquirySettings />);
    const turnOn = await screen.findByRole('button', { name: 'Turn on' });
    expect(turnOn).toBeDisabled();
    expect(screen.getByLabelText('Link to share')).toHaveValue(`${window.location.origin}/inquire/school-a`);
    fireEvent.change(screen.getByLabelText('New inquiries go to'), { target: { value: 'usr_staff' } });
    fireEvent.click(turnOn);
    await waitFor(() => expect(posts('settings/inquiry')).toEqual([{ enabled: true, defaultOwnerUserId: 'usr_staff', expectedVersion: 0 }]));
    expect(await screen.findByText('On')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeEnabled();
  });

  it('warns when the chosen owner can no longer own leads', async () => {
    handlers.push(['settings/inquiry', 'GET', () => [200, settings({ enabled: true, defaultOwnerUserId: 'usr_left', ownerEligible: false, version: 2 })]]);
    render(<InquirySettings />);
    expect(await screen.findByText(/new inquiries arrive unowned/)).toBeInTheDocument();
    expect(screen.getByLabelText('New inquiries go to')).toHaveValue('');
  });
});

describe('Public inquiry page', () => {
  const renderPage = (slug = 'school-a') => render(
    <MemoryRouter initialEntries={[`/inquire/${slug}`]}>
      <Routes><Route path="/inquire/:schoolSlug" element={<PublicInquiry />} /></Routes>
    </MemoryRouter>,
  );
  const fill = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it('checks the form in the browser, then sends it without any school field', async () => {
    sessionStorage.setItem('skyll.crm.supportSchoolId', 'sch_other');
    handlers.push(
      ['public/inquiry', 'GET', () => [200, { school: { name: 'School A' } }]],
      ['public/inquiry', 'POST', () => [200, { received: true }]],
    );
    renderPage();
    expect(await screen.findByText('School A')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send inquiry' }));
    expect(await screen.findByText('Enter your name')).toBeInTheDocument();
    expect(screen.getByText('Please agree so the school can contact you')).toBeInTheDocument();
    expect(posts('public/inquiry')).toEqual([]);

    fill('Your name', 'Sunita Nair');
    fill('Your phone number', '98200 11122');
    fill('Student’s name', 'Meera Nair');
    fill('Grade (optional)', '9');
    fireEvent.click(screen.getByLabelText(/may contact me about admissions/));
    fireEvent.click(screen.getByRole('button', { name: 'Send inquiry' }));
    expect(await screen.findByText('Thank you')).toBeInTheDocument();
    expect(posts('public/inquiry')).toEqual([{ parentName: 'Sunita Nair', parentPhone: '98200 11122', learnerName: 'Meera Nair', learnerGrade: '9', consent: true }]);
    const post = calls.find((call) => call.method === 'POST');
    expect(post.path).toBe('public/inquiry?school=school-a');
    expect(post.headers['X-Skyll-School']).toBeUndefined();
  });

  it('says the form is not available when the school link is off or wrong', async () => {
    renderPage('nope');
    expect(await screen.findByText(/This form isn.t available/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send inquiry' })).not.toBeInTheDocument();
  });

  it('shows the rate-limit message', async () => {
    handlers.push(
      ['public/inquiry', 'GET', () => [200, { school: { name: 'School A' } }]],
      ['public/inquiry', 'POST', () => [429, { error: { code: 'rate_limited', message: 'Too many inquiries right now. Please try again in an hour.' } }]],
    );
    renderPage();
    await screen.findByText('School A');
    fill('Your name', 'Sunita Nair');
    fill('Your phone number', '98200 11122');
    fill('Student’s name', 'Meera Nair');
    fireEvent.click(screen.getByLabelText(/may contact me about admissions/));
    fireEvent.click(screen.getByRole('button', { name: 'Send inquiry' }));
    expect(await screen.findByText(/try again in an hour/)).toBeInTheDocument();
  });
});
