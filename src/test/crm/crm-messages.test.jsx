// The Message dialog and message timeline entries (CRM M2 phase 2 S2).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import MessageDialog from '../../components/crm/comms/MessageDialog';
import ActivityTimeline from '../../components/crm/records/ActivityTimeline';

const notices = [
  { key: 'notice_cancelled', label: 'Class cancelled', fields: ['className', 'when'] },
  { key: 'notice_holiday', label: 'Holiday', fields: ['dates', 'occasion'] },
];
const connection = { displayPhone: '+91 98200 11122', health: 'ok', healthReason: null, mode: 'manual' };
const batchCompose = {
  target: { entityType: 'batch', entityId: 'b_1', label: 'Grade 10 Maths', batchName: 'Grade 10 Maths', studentCount: 2 },
  connection, language: 'en', senderName: 'Sharma Classes', notices,
  recipients: [
    { contactId: 'ct_k', name: 'Kavita Sharma', phone: '+919800000001', consent: true, windowOpen: false, students: ['Anaya', 'Arjun'] },
    { contactId: 'ct_r', name: 'Rohit Sharma', phone: '+919800000002', consent: true, windowOpen: true, students: ['Arjun'] },
  ],
  skipped: [{ name: 'Diya’s mother', contactId: 'ct_d', phone: null, reason: 'no_consent', students: ['Diya'] }],
  estimate: { perMessageMillipaise: 11500, total: '≈ ₹0.28' },
};

function mockApi(compose, onPost = () => ({ queued: 2, skipped: 1, groupId: 'grp_1' })) {
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const path = String(url).replace('/api/auth/crm/', '');
    const reply = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
    if (path.startsWith('messages/compose')) return reply(compose);
    if (path === 'messages' && options.method === 'POST') return reply(onPost(JSON.parse(options.body)), 201);
    if (path.startsWith('timeline')) return reply({ items: compose.timeline || [], nextCursor: null });
    if (path === 'messages/retry') return reply({ status: 'queued' });
    return reply({ error: { code: 'not_found', message: path } }, 404);
  });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Message dialog', () => {
  it('previews a batch notice with the class details, lists who is skipped, and sends to everyone who agreed', async () => {
    mockApi(batchCompose);
    render(<MessageDialog open onClose={() => {}} target={{ entityType: 'batch', entityId: 'b_1', label: 'Grade 10 Maths' }} />);
    expect(await screen.findByText(/Goes to 2 guardians/)).toHaveTextContent('of 2 students · ≈ ₹0.28');
    expect(screen.getByText('Skipped: hasn’t agreed to WhatsApp')).toBeInTheDocument();
    // A batch gets notices only, with the class prefilled.
    expect(screen.queryByRole('tab', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Class')).toHaveValue('Grade 10 Maths');
    const send = screen.getByRole('button', { name: 'Send to 2' });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Day and time'), { target: { value: 'Wed 21 Oct, 5 pm' } });
    expect(screen.getByTestId('msg-preview')).toHaveTextContent('Hello Kavita Sharma, this is Sharma Classes. The Grade 10 Maths class on Wed 21 Oct, 5 pm is cancelled.');
    fireEvent.click(send);
    expect(await screen.findByRole('status')).toHaveTextContent('Sending to 2 guardians');
    const [, post] = globalThis.fetch.mock.calls.find(([url, options]) => String(url).endsWith('/messages') && options?.method === 'POST');
    expect(JSON.parse(post.body)).toEqual({ entityType: 'batch', entityId: 'b_1', mode: 'notice', templateKey: 'notice_cancelled', fields: { className: 'Grade 10 Maths', when: 'Wed 21 Oct, 5 pm' } });
    expect(post.headers['Idempotency-Key']).toBeTruthy();
  });

  it('offers free text only inside the 24-hour window, and Send from my phone otherwise', async () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    mockApi({ ...batchCompose, target: { entityType: 'student', entityId: 'stu_2', label: 'Arjun' } }, (body) => (body.mode === 'phone' ? { link: 'https://wa.me/919800000001?text=Hi', messageId: 'msg_1' } : { queued: 1 }));
    render(<MessageDialog open onClose={() => {}} target={{ entityType: 'student', entityId: 'stu_2', label: 'Arjun' }} />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Message' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Message' }));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi' } });
    // Kavita last messaged more than 24 hours ago.
    expect(screen.getByRole('button', { name: 'Send on WhatsApp' })).toBeDisabled();
    expect(screen.getByText(/More than 24 hours since Kavita Sharma last messaged/)).toBeInTheDocument();
    // Rohit messaged today.
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'ct_r' } });
    expect(screen.getByRole('button', { name: 'Send on WhatsApp' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'ct_k' } });
    fireEvent.click(screen.getByRole('button', { name: /Send from my phone/ }));
    expect(await screen.findByRole('status')).toHaveTextContent('Opened WhatsApp on this device');
    expect(opened).toHaveBeenCalledWith('https://wa.me/919800000001?text=Hi', '_blank', 'noopener');
  });

  it('explains an unconnected class and a class on hold', async () => {
    mockApi({ ...batchCompose, connection: null });
    render(<MessageDialog open onClose={() => {}} target={{ entityType: 'batch', entityId: 'b_1', label: 'Grade 10 Maths' }} />);
    expect(await screen.findByText(/Ask an admin to connect it in Settings → WhatsApp/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to 2' })).toBeDisabled();
    cleanup();
    mockApi({ ...batchCompose, connection: { ...connection, health: 'blocked', healthReason: 'The WhatsApp connection has expired; reconnect WhatsApp' } });
    render(<MessageDialog open onClose={() => {}} target={{ entityType: 'batch', entityId: 'b_1', label: 'Grade 10 Maths' }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Messages are on hold. The WhatsApp connection has expired');
  });
});

describe('Message timeline entries', () => {
  const me = { capabilities: ['crm.access', 'crm.comms.read', 'crm.comms.send'] };
  const items = [
    { id: 'msg:1', kind: 'message', at: '2026-10-20T05:00:00.000Z', actorName: null, messageId: 'm1', messageKind: 'fee_due', via: 'api', status: 'read', body: null, amountsHidden: true, recipientName: 'Kavita Sharma', retryable: false },
    { id: 'msg:2', kind: 'message', at: '2026-10-20T04:00:00.000Z', actorName: 'Admin A', messageId: 'm2', messageKind: 'notice', via: 'api', status: 'failed', statusReason: 'WhatsApp is busy. Gave up after 5 attempts.', body: 'Hello…', recipientName: 'Rohit Sharma', retryable: true },
    { id: 'reply:1', kind: 'reply', at: '2026-10-20T03:00:00.000Z', actorName: null, contactId: 'ct_k', fromName: 'Kavita Sharma', body: 'Will pay on Friday', mediaLabel: null, isStop: false },
    { id: 'reply:2', kind: 'reply', at: '2026-10-20T02:00:00.000Z', actorName: null, contactId: 'ct_r', fromName: 'Rohit Sharma', body: 'STOP', mediaLabel: null, isStop: true },
  ];

  it('shows status, hides fee details without fee access, and offers Retry and Reply', async () => {
    mockApi({ ...batchCompose, timeline: items });
    render(<ActivityTimeline entityType="student" entityId="stu_2" me={me} label="Arjun" />);
    expect(await screen.findByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Fee details are visible to staff with fee access.')).toBeInTheDocument();
    expect(screen.getAllByText(/Automatic/)[0]).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp is busy. Gave up after 5 attempts.')).toBeInTheDocument();
    expect(screen.getByText('Will pay on Friday')).toBeInTheDocument();
    expect(screen.getByText(/replied STOP: WhatsApp updates turned off/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Reply' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findAllByText('Read');
    expect(globalThis.fetch.mock.calls.some(([url]) => String(url).endsWith('messages/retry'))).toBe(true);
  });

  it('has no Retry or Reply without send access', async () => {
    mockApi({ ...batchCompose, timeline: items });
    render(<ActivityTimeline entityType="student" entityId="stu_2" me={{ capabilities: ['crm.comms.read'] }} />);
    await screen.findByText('Read');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument();
  });
});
