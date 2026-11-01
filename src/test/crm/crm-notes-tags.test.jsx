// Notes, tags, timeline and tag settings UI (FLKRM-326 S3).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ActivityTimeline from '../../components/crm/records/ActivityTimeline';
import NotesCard from '../../components/crm/records/NotesCard';
import TagPicker from '../../components/crm/records/TagPicker';
import TagSettings from '../../components/crm/TagSettings';

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

function note(overrides = {}) {
  return {
    id: 'n1', body: 'Prefers mornings', author: { userId: 'usr_admin', name: 'Admin A' }, createdAt: '2026-09-20T09:00:00.000Z',
    updatedAt: '2026-09-20T09:00:00.000Z', edited: false, version: 1, canEdit: true, canRemove: true, ...overrides,
  };
}

beforeEach(() => { handlers = []; mockApi(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Notes', () => {
  it('adds a note, edits only your own, and confirms before removing', async () => {
    let items = [note(), note({ id: 'n2', body: 'Staff wrote this', author: { userId: 'usr_staff', name: 'Staff A' }, canEdit: false })];
    handlers.push(
      ['notes/update', 'POST', (body) => { items = items.map((item) => (item.id === body.noteId ? { ...item, body: body.body, edited: true, version: 2 } : item)); return [200, items[0]]; }],
      ['notes/remove', 'POST', (body) => { items = items.filter((item) => item.id !== body.noteId); return [200, { id: body.noteId, removed: true }]; }],
      ['notes', 'POST', (body) => { items = [note({ id: 'n3', body: body.body }), ...items]; return [201, items[0]]; }],
      ['notes?', 'GET', () => [200, { items, nextCursor: null }]],
    );
    const onChanged = vi.fn();
    render(<NotesCard entityType="lead" entityId="lead_1" canWrite onChanged={onChanged} />);
    await screen.findByText('Prefers mornings');

    const add = screen.getByRole('button', { name: 'Add note' });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText('New note'), { target: { value: '  Called back, sending fee sheet ' } });
    fireEvent.click(add);
    await screen.findByText('Called back, sending fee sheet');
    expect(posts('notes')).toEqual([{ entityType: 'lead', entityId: 'lead_1', body: 'Called back, sending fee sheet' }]);
    expect(onChanged).toHaveBeenCalled();

    const staffNote = screen.getByText('Staff wrote this').closest('li');
    expect(within(staffNote).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();

    const mine = screen.getByText('Prefers mornings').closest('li');
    fireEvent.click(within(mine).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(mine).getByLabelText('Edit note'), { target: { value: 'Prefers weekday mornings' } });
    fireEvent.click(within(mine).getByRole('button', { name: 'Save' }));
    await screen.findByText('Prefers weekday mornings');
    expect(posts('notes/update')).toEqual([{ noteId: 'n1', body: 'Prefers weekday mornings', expectedVersion: 1 }]);
    expect(screen.getByText('(edited)')).toBeInTheDocument();

    const target = screen.getByText('Staff wrote this').closest('li');
    fireEvent.click(within(target).getByRole('button', { name: 'Remove' }));
    const confirm = within(target).getByRole('group', { name: 'Confirm removal' });
    expect(posts('notes/remove')).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('Staff wrote this')).not.toBeInTheDocument());
    expect(posts('notes/remove')).toEqual([{ noteId: 'n2', expectedVersion: 1 }]);
  });

  it('is read-only without write access', async () => {
    handlers.push(['notes?', 'GET', () => [200, { items: [note({ canEdit: false, canRemove: false })], nextCursor: null }]]);
    render(<NotesCard entityType="lead" entityId="lead_1" canWrite={false} />);
    await screen.findByText('Prefers mornings');
    expect(screen.queryByLabelText('New note')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});

describe('Tag picker', () => {
  const existing = [{ id: 'tag_hot', label: 'Hot lead', color: 'red', archived: false }, { id: 'tag_sib', label: 'Sibling', color: 'green', archived: false }];

  it('applies an existing tag, creates a new one by name, and removes a chip', async () => {
    handlers.push(
      ['tags/apply', 'POST', (body) => [200, { items: [body.tagId ? existing.find((tag) => tag.id === body.tagId) : { id: 'tag_new', label: body.label, color: 'gray', archived: false }] }]],
      ['tags/remove', 'POST', () => [200, { items: [] }]],
      ['tags', 'GET', () => [200, { items: existing, nextCursor: null }]],
    );
    const onChange = vi.fn();
    const { rerender } = render(<TagPicker entityType="lead" entityId="lead_1" tags={[]} canWrite onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    const input = await screen.findByRole('combobox', { name: 'Add a tag' });
    fireEvent.change(input, { target: { value: 'hot' } });
    const option = await screen.findByRole('option', { name: /Hot lead/ });
    fireEvent.mouseDown(option);
    await waitFor(() => expect(posts('tags/apply')).toEqual([{ entityType: 'lead', entityId: 'lead_1', tagId: 'tag_hot' }]));
    expect(onChange).toHaveBeenLastCalledWith([existing[0]]);

    rerender(<TagPicker entityType="lead" entityId="lead_1" tags={[existing[0]]} canWrite onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    const again = await screen.findByRole('combobox', { name: 'Add a tag' });
    fireEvent.change(again, { target: { value: 'Scholarship' } });
    expect(await screen.findByRole('option', { name: /Create tag .Scholarship./ })).toBeInTheDocument();
    // An applied tag is not offered again.
    fireEvent.change(again, { target: { value: 'Hot' } });
    expect(screen.queryByRole('option', { name: /Hot lead/ })).not.toBeInTheDocument();
    fireEvent.change(again, { target: { value: 'Scholarship' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    await waitFor(() => expect(posts('tags/apply')[1]).toEqual({ entityType: 'lead', entityId: 'lead_1', label: 'Scholarship' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove tag Hot lead' }));
    await waitFor(() => expect(posts('tags/remove')).toEqual([{ entityType: 'lead', entityId: 'lead_1', tagId: 'tag_hot' }]));
  });

  it('shows archived tags greyed out and offers no controls when read-only', () => {
    render(<TagPicker entityType="lead" entityId="lead_1" tags={[{ id: 't', label: 'Old campaign', color: 'blue', archived: true }]} canWrite={false} onChange={() => {}} />);
    expect(screen.getByTitle('Old campaign (archived)').className).toMatch(/line-through/);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('Activity timeline', () => {
  it('describes each kind of activity in plain words', async () => {
    handlers.push(['timeline?', 'GET', () => [200, {
      items: [
        { id: 'a1', kind: 'owner', at: '2026-09-21T10:00:00.000Z', actorName: 'Admin A', fromName: 'Admin A', toName: 'Staff A' },
        { id: 'a2', kind: 'tag', at: '2026-09-21T09:00:00.000Z', actorName: 'Admin A', change: 'added', label: 'Hot lead' },
        { id: 'a3', kind: 'task', at: '2026-09-21T08:00:00.000Z', actorName: 'Admin A', event: 'completed', title: 'Call back' },
        { id: 'a4', kind: 'stage', at: '2026-09-21T07:00:00.000Z', actorName: 'Admin A', from: { name: 'Contacted' }, to: { name: 'Lost' }, reason: 'Price / fees' },
        { id: 'a5', kind: 'note_removed', at: '2026-09-21T06:00:00.000Z', actorName: 'Admin A' },
        { id: 'a6', kind: 'updated', at: '2026-09-21T05:00:00.000Z', actorName: 'Admin A', fields: ['learnerGrade', 'interest'] },
      ],
      nextCursor: null,
    }]]);
    render(<ActivityTimeline entityType="lead" entityId="lead_1" refreshKey={0} />);
    const list = await screen.findByRole('list', { name: 'Activity' });
    const text = within(list).getAllByRole('listitem').map((item) => item.textContent);
    expect(text[0]).toMatch(/Owner changed from Admin A to Staff A/);
    expect(text[1]).toMatch(/Tag Hot lead added/);
    expect(text[2]).toMatch(/Task Call back done/);
    expect(text[3]).toMatch(/Moved from Contacted to Lost.*Reason: Price \/ fees/);
    expect(text[4]).toMatch(/A note was removed/);
    expect(text[5]).toMatch(/Details edited: grade, interest/);
  });
});

describe('Tag settings', () => {
  it('creates, renames and archives tags, and shows a clash as an error', async () => {
    let tags = [{ id: 'tag_hot', label: 'Hot lead', color: 'red', archived: false, usage: 3 }];
    handlers.push(
      ['settings/tags/update', 'POST', (body) => (body.label === 'Sibling'
        ? [422, { error: { code: 'duplicate_name', message: 'A tag with this name already exists' } }]
        : [200, (tags = tags.map((tag) => (tag.id === body.tagId ? { ...tag, ...body } : tag)))[0]])],
      ['settings/tags/archive', 'POST', (body) => [200, (tags = tags.map((tag) => (tag.id === body.tagId ? { ...tag, archived: body.archived } : tag)))[0]]],
      ['settings/tags', 'POST', (body) => { tags = [...tags, { id: 'tag_sib', label: body.label, color: body.color, archived: false, usage: 0 }]; return [201, tags[1]]; }],
      ['tags?', 'GET', () => [200, { items: tags, nextCursor: null }]],
    );
    render(<TagSettings />);
    await screen.findByLabelText('Name of tag Hot lead');
    expect(screen.getByText('3 records')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('New tag name'), { target: { value: 'Sibling' } });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Colour of new tag' })).getByRole('radio', { name: 'green' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    await screen.findByLabelText('Name of tag Sibling');
    expect(posts('settings/tags')).toEqual([{ label: 'Sibling', color: 'green' }]);

    fireEvent.change(screen.getByLabelText('Name of tag Hot lead'), { target: { value: 'Sibling' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('A tag with this name already exists')).toBeInTheDocument();

    const hotRow = screen.getByLabelText('Name of tag Hot lead').closest('li');
    fireEvent.click(within(hotRow).getByRole('button', { name: 'Archive' }));
    const archived = await screen.findByRole('region', { name: 'Archived tags' });
    expect(within(archived).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(posts('settings/tags/archive')).toEqual([{ tagId: 'tag_hot', archived: true }]);
  });
});
