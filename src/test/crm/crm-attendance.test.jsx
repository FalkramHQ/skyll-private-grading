// Attendance UI (FLKRM-327 S5): the sheet (All present, corrections with a
// reason, conflicts, read-only states) and the Today / Waiting lists.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AttendancePage from '../../components/crm/attendance/AttendancePage';
import AttendanceSheet from '../../components/crm/attendance/AttendanceSheet';

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

function me(capabilities, attendanceScope = 'own') {
  return { user: { id: 'usr_teacher', role: 'teacher' }, school: { id: 'sch_a', name: 'A', timezone: 'Asia/Kolkata' }, capabilities, sections: ['attendance'], support: false, taskScope: 'own', attendanceScope, crmOnly: false };
}
const TEACHER = me(['crm.access', 'crm.attendance.read', 'crm.attendance.write']);

const session = {
  id: 'cs_1', batch: { id: 'b_math10', name: 'Grade 10 Maths' }, subject: { name: 'Mathematics' }, instructor: { userId: 'usr_teacher', name: 'Teacher A' }, room: { name: 'Room 2' },
  localDate: '2026-10-08', startsAt: '2026-10-08T10:30:00.000Z', endsAt: '2026-10-08T12:00:00.000Z', status: 'scheduled', notMarked: false,
};
const student = (studentId, name, overrides = {}) => ({ studentId, name, status: null, note: null, version: null, markedBy: null, updatedBy: null, updatedAt: null, ...overrides });
const sheet = (overrides = {}) => ({
  session, students: [student('stu_1', 'Anaya Iyer'), student('stu_3', 'Diya Rao'), student('stu_2', 'Arjun Sharma', { status: 'absent', version: 1, markedBy: 'Teacher A' })],
  counts: {}, canMark: true, blockedReason: null, locksAfter: '2026-10-15', schoolWide: false, ...overrides,
});

function renderSheet(user = TEACHER) {
  return render(<MemoryRouter initialEntries={['/crm/attendance/cs_1']}><Routes><Route path="/crm/attendance/:sessionId" element={<AttendanceSheet me={user} />} /></Routes></MemoryRouter>);
}

beforeEach(() => {
  handlers = [
    ['attendance/sheet?', 'GET', () => [200, sheet()]],
    ['attendance/mark', 'POST', () => [200, sheet({ students: [student('stu_1', 'Anaya Iyer', { status: 'present', version: 1 }), student('stu_3', 'Diya Rao', { status: 'present', version: 1 }), student('stu_2', 'Arjun Sharma', { status: 'absent', version: 1 })] })]],
  ];
  mockApi();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Attendance sheet', () => {
  it('marks everyone unmarked present with one tap, then saves only the changes', async () => {
    renderSheet();
    expect(await screen.findByText('Grade 10 Maths')).toBeInTheDocument();
    expect(screen.getByText('2 not marked')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /All present/ }));
    expect(screen.getByText('2 present')).toBeInTheDocument();
    // Saved marks aren't overwritten by "All present".
    expect(within(screen.getByRole('radiogroup', { name: 'Attendance for Arjun Sharma' })).getByRole('radio', { name: 'Absent' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Attendance for Diya Rao' })).getByRole('radio', { name: 'Late' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 marks' }));
    await waitFor(() => expect(posts('attendance/mark')).toEqual([{ sessionId: 'cs_1', marks: [{ studentId: 'stu_1', status: 'present' }, { studentId: 'stu_3', status: 'late' }] }]));
    expect(await screen.findByText('Attendance saved.')).toBeInTheDocument();
  });

  it('asks why a saved mark changed before saving the correction', async () => {
    renderSheet();
    const arjun = await screen.findByRole('radiogroup', { name: 'Attendance for Arjun Sharma' });
    fireEvent.click(within(arjun).getByRole('radio', { name: 'Late' }));
    expect(screen.getByText('Add a reason for each changed mark.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save 1 mark' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason for changing Arjun Sharma's mark"), { target: { value: 'other' } });
    expect(screen.getByRole('button', { name: 'Save 1 mark' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Say why Arjun Sharma's mark changed"), { target: { value: 'Was in the library' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 mark' }));
    await waitFor(() => expect(posts('attendance/mark')).toEqual([{
      sessionId: 'cs_1', marks: [{ studentId: 'stu_2', status: 'late', expectedVersion: 1, reasonKey: 'other', reasonNote: 'Was in the library' }],
    }]));
  });

  it('explains a conflict and reloads the sheet', async () => {
    handlers.unshift(['attendance/mark', 'POST', () => [409, { error: { code: 'attendance_conflict', message: 'x', details: { studentIds: ['stu_1'] } } }]]);
    renderSheet();
    fireEvent.click(within(await screen.findByRole('radiogroup', { name: 'Attendance for Anaya Iyer' })).getByRole('radio', { name: 'Present' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 mark' }));
    expect(await screen.findByText(/Someone else saved this sheet meanwhile/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(calls.filter((call) => call.path.startsWith('attendance/sheet')).length).toBe(2));
  });

  it('shows why a sheet is read-only and offers no controls', async () => {
    handlers.unshift(['attendance/sheet?', 'GET', () => [200, sheet({ canMark: false, blockedReason: 'not_your_class' })]]);
    renderSheet();
    expect(await screen.findByText(/Not your class/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /All present/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Save/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole('radiogroup', { name: 'Attendance for Anaya Iyer' })).getByRole('radio', { name: 'Present' })).toBeDisabled();
  });
});

describe('Attendance page', () => {
  it('lists today\'s classes with progress, and the classes waiting for attendance', async () => {
    handlers.unshift(
      ['attendance/today?', 'GET', () => [200, { view: 'mine', items: [{ ...session, status: 'held', markedCount: 2, rosterCount: 3 }], nextCursor: null }]],
      ['attendance/pending', 'GET', () => [200, { scope: 'own', items: [{ ...session, id: 'cs_0', localDate: '2026-10-06', notMarked: true, markedCount: 0, rosterCount: 3 }], nextCursor: null }]],
    );
    render(<MemoryRouter><AttendancePage me={TEACHER} /></MemoryRouter>);
    expect(await screen.findByText('2/3 marked')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Grade 10 Maths/ })).toHaveAttribute('href', '/crm/attendance/cs_1');
    // Own-class teachers have no "All classes" switch.
    expect(screen.queryByRole('button', { name: 'All classes' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Waiting for attendance' }));
    expect(await screen.findByText('Not marked')).toBeInTheDocument();
    expect(screen.getByText(/Sheets lock 7 days after the class/)).toBeInTheDocument();
  });
});
