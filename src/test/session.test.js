import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from '../lib/auth';
import { signIn } from '../lib/session';

describe('server-backed sign in', () => {
  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it('sends portal constraints to the server before accepting a session', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { username: 'student_1', role: 'student', school: 'PartnerG' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await signIn('student_1', 'secret', { expectedSchool: 'PartnerG' });

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      body: JSON.stringify({
        username: 'student_1',
        password: 'secret',
        expectedSchool: 'PartnerG',
      }),
    }));
    expect(localStorage.getItem('username')).toBe('student_1');
    expect(localStorage.getItem('userSchool')).toBe('PartnerG');
  });

  it('does not create client session state when the server rejects portal scope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'This account belongs to a different school portal' }),
    }));

    await expect(signIn('other_student', 'secret', { expectedSchool: 'PartnerG' }))
      .rejects.toThrow('different school portal');
    expect(localStorage.getItem('username')).toBeNull();
  });
});
