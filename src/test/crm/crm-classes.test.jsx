// Classes UI (FLKRM-327 S1): batches and courses lists, the course and batch
// forms, batch students, and what teachers can't change.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import BatchPage from '../../components/crm/classes/BatchPage';
import ClassesPage from '../../components/crm/classes/ClassesPage';

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

function me(capabilities, extra = {}) {
  return {
    user: { id: 'usr_admin', role: 'admin' }, school: { id: 'sch_a', name: 'A', timezone: 'Asia/Kolkata' },
    capabilities, sections: ['classes'], support: false, taskScope: 'school', crmOnly: false, ...extra,
  };
}
const ADMIN = me(['crm.access', 'crm.classes.read', 'crm.classes.write', 'crm.students.read']);
const TEACHER = me(['crm.access', 'crm.classes.read', 'crm.students.read'], { user: { id: 'usr_teacher', role: 'teacher' } });

const options = {
  academicYears: [{ id: 'ay_26', label: '2026-27', isCurrent: true }, { id: 'ay_25', label: '2025-26', isCurrent: false }],
  subjects: [{ id: 'sub_math', name: 'Mathematics' }],
  rooms: [{ id: 'room_2', name: 'Room 2', seats: 30, status: 'active', version: 1 }],
  courses: [{ id: 'course_1', name: 'Grade 10 Maths tuition', subjectId: 'sub_math', level: 'Grade 10', duration: { value: 10, unit: 'months' }, deliveryMode: 'classroom', academicYearId: null }],
  programs: ['Board prep'],
};

const batch = {
  id: 'b_math10', name: 'Grade 10 Maths', grade: '10', status: 'active', academicYear: { id: 'ay_26', label: '2026-27' }, subject: { id: 'sub_math', name: 'Mathematics' },
  course: null, startsOn: null, endsOn: null, capacity: 2, defaultRoom: null, defaultOnlineUrl: null, studentCount: 3, version: 0,
};

beforeEach(() => {
  handlers = [
    ['classes/options', 'GET', () => [200, options]],
    ['classes/batches/detail', 'GET', () => [200, batch]],
    ['classes/batches/students?', 'GET', () => [200, { items: [{ membershipId: 'bm_1', studentId: 'stu_1', name: 'Anaya Iyer', joinedAt: '2026-06-01T00:00:00.000Z', leftAt: null }], nextCursor: null }]],
    ['classes/batches?', 'GET', () => [200, { items: [batch], nextCursor: null }]],
    ['classes/courses?', 'GET', () => [200, { items: [{ ...options.courses[0], program: 'Board prep', subject: { id: 'sub_math', name: 'Mathematics' }, academicYear: null, description: null, status: 'active', version: 1, batches: [] }], nextCursor: null }]],
    ['students?', 'GET', () => [200, { items: [{ id: 'stu_1', name: 'Anaya Iyer', batches: [] }, { id: 'stu_3', name: 'Diya Rao', batches: [] }], nextCursor: null }]],
    ['classes/batches/students/add', 'POST', () => [200, { added: 1, alreadyInBatch: 0, overCapacity: true, batch: { ...batch, studentCount: 3 } }]],
    ['classes/batches', 'POST', (body) => [201, { ...batch, ...body, id: 'b_new' }]],
    ['classes/courses', 'POST', (body) => [201, { ...body, id: 'course_new' }]],
  ];
  mockApi();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderClasses(user, entry = '/crm/classes') {
  return render(<MemoryRouter initialEntries={[entry]}><Routes><Route path="/crm/classes" element={<ClassesPage me={user} />} /></Routes></MemoryRouter>);
}

describe('Classes page', () => {
  it('lists batches with course, year, class and students over capacity', async () => {
    renderClasses(ADMIN);
    // The table (wider screens) and the card list (phones) both render in jsdom.
    const row = within(await screen.findByRole('table')).getByRole('link', { name: 'Grade 10 Maths' }).closest('tr');
    expect(within(row).getByText('2026-27')).toBeInTheDocument();
    expect(within(row).getByText('3 / 2')).toHaveClass('text-warning-soft-foreground');
    expect(screen.getAllByRole('link', { name: 'Grade 10 Maths' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: /New batch/ })).toBeInTheDocument();
  });

  it('creates a batch from a course, filling subject, class and end date from it', async () => {
    renderClasses(ADMIN);
    fireEvent.click(await screen.findByRole('button', { name: /New batch/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Batch name'), { target: { value: 'Grade 10 Maths Evening' } });
    fireEvent.change(within(dialog).getByLabelText('Starts on (optional)'), { target: { value: '2026-06-15' } });
    fireEvent.change(within(dialog).getByLabelText('Course (optional)'), { target: { value: 'course_1' } });
    expect(within(dialog).getByLabelText('Class (optional)')).toHaveValue('10');
    expect(within(dialog).getByLabelText('Subject (optional)')).toHaveValue('sub_math');
    expect(within(dialog).getByLabelText('Ends on (optional)')).toHaveValue('2027-04-14');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create batch' }));
    await waitFor(() => expect(posts('classes/batches')).toHaveLength(1));
    expect(posts('classes/batches')[0]).toMatchObject({
      name: 'Grade 10 Maths Evening', courseId: 'course_1', academicYearId: 'ay_26', grade: '10', subjectId: 'sub_math', startsOn: '2026-06-15', endsOn: '2027-04-14',
    });
  });

  it('fixes the course when a batch is started from a course card', async () => {
    renderClasses(ADMIN, '/crm/classes?tab=courses');
    fireEvent.click(await screen.findByRole('button', { name: 'New batch' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New batch for Grade 10 Maths tuition' })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Course (optional)')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Grade 10 Maths tuition', { selector: 'p' })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Batch name'), { target: { value: 'Grade 10 Maths Weekend' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create batch' }));
    await waitFor(() => expect(posts('classes/batches')).toEqual([expect.objectContaining({ name: 'Grade 10 Maths Weekend', courseId: 'course_1', grade: '10', subjectId: 'sub_math' })]));
  });

  it('validates the course form with the server schema before sending', async () => {
    renderClasses(ADMIN, '/crm/classes?tab=courses');
    expect(await screen.findByText('Grade 10 Maths tuition')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /New course/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create course' }));
    expect(await within(dialog).findByText('Enter a course name')).toBeInTheDocument();
    expect(posts('classes/courses')).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText('Course name'), { target: { value: 'German A2' } });
    fireEvent.change(within(dialog).getByLabelText('Delivery'), { target: { value: 'online' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create course' }));
    await waitFor(() => expect(posts('classes/courses')).toEqual([expect.objectContaining({ name: 'German A2', deliveryMode: 'online', subjectId: null, durationValue: null })]));
  });

  it('shows teachers the lists without any change buttons', async () => {
    renderClasses(TEACHER);
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: /New batch/ })).not.toBeInTheDocument();
  });
});

describe('Batch page', () => {
  function renderBatch(user) {
    return render(
      <MemoryRouter initialEntries={['/crm/classes/batches/b_math10']}>
        <Routes><Route path="/crm/classes/batches/:batchId" element={<BatchPage me={user} />} /></Routes>
      </MemoryRouter>,
    );
  }

  it('adds students and warns when the batch goes over capacity', async () => {
    renderBatch(ADMIN);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /Students/ }));
    expect(await screen.findByRole('link', { name: 'Anaya Iyer' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add students/ }));
    const dialog = await screen.findByRole('dialog');
    // Current members aren't offered again.
    await within(dialog).findByText('Diya Rao');
    expect(within(dialog).queryByText('Anaya Iyer')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 1' }));
    await waitFor(() => expect(posts('classes/batches/students/add')).toEqual([{ batchId: 'b_math10', studentIds: ['stu_3'] }]));
    expect(await screen.findByText(/over its capacity of 2/)).toBeInTheDocument();
    // No finance access, so no fee set-up offer.
    expect(screen.queryByText(/Set up fees/)).not.toBeInTheDocument();
  });

  it('offers fee set-up for the students just added, with finance write (FLKRM-328 S5)', async () => {
    renderBatch(me([...ADMIN.capabilities, 'crm.finance.write']));
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /Students/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Add students/ }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Diya Rao');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 1' }));
    expect(await screen.findByRole('link', { name: 'Diya Rao' })).toHaveAttribute('href', '/crm/students/stu_3?fees=setup&batch=b_math10');
  });

  it('asks before removing a student', async () => {
    handlers.unshift(['classes/batches/students/remove', 'POST', () => [200, { removed: true, batch: { ...batch, studentCount: 2 } }]]);
    renderBatch(ADMIN);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /Students/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Anaya Iyer from the batch' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm removal' })).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(posts('classes/batches/students/remove')).toEqual([{ batchId: 'b_math10', membershipId: 'bm_1' }]));
    expect(await screen.findByText(/Anaya Iyer left Grade 10 Maths/)).toBeInTheDocument();
  });

  it('gives teachers a read-only batch', async () => {
    renderBatch(TEACHER);
    expect(await screen.findByRole('heading', { name: 'Grade 10 Maths' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Students/ }));
    await screen.findByRole('link', { name: 'Anaya Iyer' });
    expect(screen.queryByRole('button', { name: /Add students/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
  });
});
