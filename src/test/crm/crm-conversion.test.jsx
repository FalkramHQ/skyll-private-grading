// Conversion dialog and pipeline settings UI (FLKRM-326 S5).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PipelineSettings from '../../components/crm/PipelineSettings';
import ConvertDialog from '../../components/crm/leads/ConvertDialog';

let calls;
let handlers;

function mockApi() {
  calls = [];
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const path = String(url).replace('/api/auth/crm/', '');
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method: options.method || 'GET', path, body });
    const handler = handlers.find(([match, method]) => path.startsWith(match) && (!method || method === (options.method || 'GET')));
    const [status, payload] = handler ? handler[2](body, path) : [404, { error: { code: 'not_found', message: path } }];
    return { ok: status < 400, status, json: async () => payload };
  });
}
const posts = (path) => calls.filter((call) => call.method === 'POST' && call.path === path).map((call) => call.body);

const BATCHES = [
  { id: 'b_math9', name: 'Grade 9 Maths', grade: '9', academicYear: '2026-27', hasAcademicYear: true },
  { id: 'b_camp', name: 'Summer camp', grade: null, academicYear: null, hasAcademicYear: false },
];
function preview(overrides = {}) {
  return {
    leadId: 'lead_1', learnerName: 'Meera Nair', learnerGrade: '9', version: 3, convertedStudentId: null, canConvert: true, hasContact: true,
    requirements: [], candidates: [], batches: BATCHES, suggestedBatchIds: ['b_math9'], ...overrides,
  };
}

function renderDialog() {
  return render(
    <MemoryRouter initialEntries={['/crm/leads/lead_1']}>
      <Routes>
        <Route path="/crm/leads/:leadId" element={<ConvertDialog leadId="lead_1" open onClose={() => {}} />} />
        <Route path="/crm/students/:studentId" element={<p>student page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => { handlers = []; mockApi(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Convert dialog', () => {
  it('creates a new student with the suggested batch and relationship, then opens the student', async () => {
    handlers.push(
      ['leads/conversion', 'GET', () => [200, preview()]],
      ['leads/convert', 'POST', () => [200, { studentId: 'stu_new', mode: 'created', alreadyConverted: false }]],
    );
    renderDialog();
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/No existing student matches/)).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Create a new student/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /Grade 9 Maths/ })).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText(/How are they related/), { target: { value: 'mother' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create student and enroll' }));
    expect(await screen.findByText('student page')).toBeInTheDocument();
    expect(posts('leads/convert')).toEqual([{ leadId: 'lead_1', expectedVersion: 3, mode: 'create', batchIds: ['b_math9'], relationship: 'mother' }]);
  });

  it('makes staff choose between a match and a new student, and confirm "none of these"', async () => {
    handlers.push(
      ['leads/conversion', 'GET', () => [200, preview({ candidates: [{ studentId: 'stu_riya', name: 'Riya Nair', status: 'active', reasons: ['phone'], batches: ['Grade 7 Maths'] }] })]],
      ['leads/convert', 'POST', () => [200, { studentId: 'stu_riya', mode: 'linked', alreadyConverted: false }]],
    );
    renderDialog();
    const dialog = await screen.findByRole('dialog');
    const convertButton = await within(dialog).findByRole('button', { name: /enroll/ });
    expect(within(dialog).getByText('Same parent phone')).toBeInTheDocument();
    expect(convertButton).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('radio', { name: /Create a new student/ }));
    expect(within(dialog).getByRole('button', { name: 'Create student and enroll' })).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText(/none of the students above is this learner/));
    expect(within(dialog).getByRole('button', { name: 'Create student and enroll' })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole('radio', { name: /Link to Riya Nair/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Link and enroll' }));
    await waitFor(() => expect(posts('leads/convert')).toHaveLength(1));
    expect(posts('leads/convert')[0]).toEqual(expect.objectContaining({ mode: 'link', studentId: 'stu_riya' }));
    expect(posts('leads/convert')[0].confirmNoMatch).toBeUndefined();
  });

  it('blocks conversion while requirements are missing or no batch has an academic year', async () => {
    handlers.push(['leads/conversion', 'GET', () => [200, preview({
      requirements: [{ key: 'guardianPhone', label: 'A parent contact with a phone number', met: true }, { key: 'source', label: 'Where the lead came from (source)', met: false }],
      suggestedBatchIds: [],
    })]]);
    renderDialog();
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Where the lead came from/)).toBeInTheDocument();
    expect(within(dialog).getByText('(missing)')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Summer camp/ }));
    expect(within(dialog).getByText(/Choose at least one batch with an academic year/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create student and enroll' })).toBeDisabled();
  });

  it('shows the student when the lead is already converted', async () => {
    handlers.push(['leads/conversion', 'GET', () => [200, preview({ convertedStudentId: 'stu_new' })]]);
    renderDialog();
    expect(await screen.findByRole('link', { name: 'Open the student' })).toHaveAttribute('href', '/crm/students/stu_new');
  });
});

describe('Pipeline settings (S5)', () => {
  const stages = [
    { id: 'st_new', key: 'new_inquiry', name: 'New inquiry', category: 'open', position: 0, version: 1, leadCount: 2 },
    { id: 'st_contact', key: 'contacted', name: 'Contacted', category: 'open', position: 1, version: 1, leadCount: 0 },
    { id: 'st_app', key: 'application', name: 'Application', category: 'applicant', position: 2, version: 1, leadCount: 0 },
    { id: 'st_won', key: 'enrolled', name: 'Enrolled', category: 'won', position: 3, version: 1, leadCount: 1 },
    { id: 'st_lost', key: 'lost', name: 'Lost', category: 'lost', position: 4, version: 1, leadCount: 0 },
  ];
  const requirements = { guardianPhone: false, learnerGrade: false, source: false, applicantStage: false };
  const pipeline = { id: 'pl', name: 'Admissions', version: 5, stages, requirements };

  beforeEach(() => {
    handlers.push(
      ['settings/pipeline/stages', 'POST', () => [200, pipeline]],
      ['settings/pipeline/archive', 'POST', () => [200, pipeline]],
      ['settings/pipeline/requirements', 'POST', (body) => [200, { ...pipeline, requirements: body.requirements }]],
      ['settings/pipeline', 'GET', () => [200, pipeline]],
    );
  });

  it('adds a stage of the chosen type with the pipeline version', async () => {
    render(<PipelineSettings />);
    fireEvent.change(await screen.findByLabelText('New stage name'), { target: { value: 'Demo class booked' } });
    fireEvent.change(screen.getByLabelText('New stage type'), { target: { value: 'applicant' } });
    fireEvent.click(screen.getByRole('button', { name: /Add stage/ }));
    await waitFor(() => expect(posts('settings/pipeline/stages')).toEqual([{ name: 'Demo class booked', category: 'applicant', expectedVersion: 5 }]));
  });

  it('asks where leads go before archiving a stage that has some; Enrolled and Lost stay', async () => {
    render(<PipelineSettings />);
    await screen.findByLabelText('Archive New inquiry');
    expect(screen.getByLabelText('Archive Enrolled')).toBeDisabled();
    expect(screen.getByLabelText('Archive Lost')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Archive New inquiry'));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Archive stage' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Move its 2 leads to/), { target: { value: 'st_contact' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(posts('settings/pipeline/archive')).toEqual([{ stageId: 'st_new', destinationStageId: 'st_contact', expectedVersion: 5 }]));
  });

  it('saves the requirements before enrollment', async () => {
    render(<PipelineSettings />);
    fireEvent.click(await screen.findByLabelText(/A parent contact with a phone number/));
    fireEvent.click(screen.getByLabelText(/reached an application stage/));
    fireEvent.click(screen.getByRole('button', { name: 'Save requirements' }));
    await waitFor(() => expect(posts('settings/pipeline/requirements')).toEqual([{ requirements: { ...requirements, guardianPhone: true, applicantStage: true }, expectedVersion: 5 }]));
  });
});
