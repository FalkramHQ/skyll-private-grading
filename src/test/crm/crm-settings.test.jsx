import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import CrmSettings from '../../pages/crm/CrmSettings';
import { CAPABILITIES } from '../../../shared/crm/capabilities.js';

const team = {
  items: [
    { userId: 'usr_staff', name: 'Staff A', username: 'a_staff', role: 'staff', defaults: [], grants: ['crm.access'] },
  ],
  nextCursor: null,
  presets: [{ key: 'finance', label: 'Finance', capabilities: ['crm.access', 'crm.finance.read'] }],
};

const stages = [
  { id: 'st_new', key: 'new_inquiry', name: 'New inquiry', category: 'open', position: 0, version: 1, leadCount: 0 },
  { id: 'st_app', key: 'application', name: 'Application', category: 'applicant', position: 1, version: 1, leadCount: 0 },
  { id: 'st_won', key: 'enrolled', name: 'Enrolled', category: 'won', position: 2, version: 1, leadCount: 0 },
];
const pipeline = { id: 'pl_a', name: 'Admissions', version: 1, stages, requirements: { guardianPhone: false, learnerGrade: false, source: false, applicantStage: false } };
let pipelineWrite = () => [500, {}];

function mockApi() {
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const path = String(url).replace('/api/auth/crm/', '');
    if (path.startsWith('permissions/team')) return { ok: true, status: 200, json: async () => team };
    if (path === 'permissions/grants') {
      return { ok: true, status: 200, json: async () => ({ userId: 'usr_staff', grants: ['crm.access', 'crm.finance.read'] }) };
    }
    if (path === 'permissions/revoke') return { ok: true, status: 200, json: async () => ({ userId: 'usr_staff', grants: [] }) };
    if (path === 'settings/pipeline') return { ok: true, status: 200, json: async () => pipeline };
    if (path === 'settings/pipeline/rename' || path === 'settings/pipeline/reorder') {
      const [status, body] = pipelineWrite(path, JSON.parse(options.body));
      return { ok: status < 400, status, json: async () => body };
    }
    if (path.startsWith('audit')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{
            id: 'aud_1', action: 'permission.granted', entityType: 'user', entityId: 'usr_staff',
            actor: { userId: 'usr_admin', name: 'Admin A', role: 'admin' }, summary: { capability: 'crm.finance.read' }, createdAt: '2026-09-24T09:00:00.000Z',
          }],
          nextCursor: null,
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: { code: 'not_found', message: `unexpected ${options.method || 'GET'} ${path}` } }) };
  });
}

// Radix tabs switch on mousedown.
function openTab(name) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CRM settings', () => {
  it('shows only the tabs the user may use', () => {
    mockApi();
    render(<CrmSettings me={{ capabilities: ['crm.access', 'crm.audit.read'] }} />);
    expect(screen.queryByRole('tab', { name: 'Team access' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Audit log' })).toBeInTheDocument();
  });

  it('grants a bundle with an Idempotency-Key and removes access', async () => {
    mockApi();
    render(<CrmSettings me={{ capabilities: [...CAPABILITIES] }} />);
    openTab('Team access');
    const card = (await screen.findByText('Staff A')).closest('.rounded-2xl');
    fireEvent.change(within(card).getByRole('combobox'), { target: { value: 'preset:finance' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Grant' }));

    const remove = await within(card).findByRole('button', { name: 'Remove Fees · view' });
    const [, grantCall] = globalThis.fetch.mock.calls.find(([url]) => String(url).endsWith('permissions/grants'));
    expect(JSON.parse(grantCall.body)).toEqual({ userId: 'usr_staff', preset: 'finance' });
    expect(grantCall.headers['Idempotency-Key']).toBeTruthy();

    fireEvent.click(remove);
    expect(await within(card).findByText('No extra access')).toBeInTheDocument();
  });

  it('only offers bundles the admin fully holds', async () => {
    mockApi();
    render(<CrmSettings me={{ capabilities: ['crm.access', 'crm.permissions.manage'] }} />);
    await screen.findByText('Staff A');
    expect(screen.queryByRole('option', { name: 'Finance' })).not.toBeInTheDocument();
  });

  it('lists audit events with readable labels', async () => {
    mockApi();
    render(<CrmSettings me={{ capabilities: ['crm.audit.read'] }} />);
    expect(await screen.findByText('Access granted')).toBeInTheDocument();
    expect(screen.getByText('Fees · view')).toBeInTheDocument();
    expect(screen.getByText('Admin A')).toBeInTheDocument();
  });

  it('opens on the Pipeline tab for admins and renames a stage with its version', async () => {
    pipelineWrite = (_path, body) => [200, { ...pipeline, stages: stages.map((stage) => (stage.id === body.stageId ? { ...stage, name: body.name, version: 2 } : stage)) }];
    mockApi();
    render(<CrmSettings me={{ capabilities: [...CAPABILITIES] }} />);
    const input = await screen.findByRole('textbox', { name: 'Name of stage 1' });
    expect(screen.getByText('Enrolled', { selector: '[title]' })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Walk-in enquiry' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByDisplayValue('Walk-in enquiry')).toBeInTheDocument();
    const [, call] = globalThis.fetch.mock.calls.find(([url]) => String(url).endsWith('settings/pipeline/rename'));
    expect(JSON.parse(call.body)).toEqual({ stageId: 'st_new', name: 'Walk-in enquiry', expectedVersion: 1 });
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('moves a stage by sending the full new order and the pipeline version', async () => {
    pipelineWrite = (_path, body) => [200, { ...pipeline, version: 2, stages: body.stageIds.map((stageId) => stages.find((stage) => stage.id === stageId)) }];
    mockApi();
    render(<CrmSettings me={{ capabilities: [...CAPABILITIES] }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move New inquiry down' }));
    expect(await screen.findByRole('button', { name: 'Move New inquiry up' })).not.toBeDisabled();
    const [, call] = globalThis.fetch.mock.calls.find(([url]) => String(url).endsWith('settings/pipeline/reorder'));
    expect(JSON.parse(call.body)).toEqual({ stageIds: ['st_app', 'st_new', 'st_won'], expectedVersion: 1 });
    expect(screen.getByRole('button', { name: 'Move Application up' })).toBeDisabled();
  });

  it('explains a version conflict and offers to reload', async () => {
    pipelineWrite = () => [409, { error: { code: 'version_conflict', message: 'This was changed by someone else.', details: { currentVersion: 2 } } }];
    mockApi();
    render(<CrmSettings me={{ capabilities: [...CAPABILITIES] }} />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name of stage 2' }), { target: { value: 'Applied' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Someone else changed the pipeline while you were editing.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    expect(await screen.findByDisplayValue('Application')).toBeInTheDocument();
  });
});
