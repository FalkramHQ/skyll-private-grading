import { describe, expect, it } from 'vitest';
import { canRequestRecheckForReport, mergeRecheckResponse } from '../lib/recheckUi.js';

describe('report-page recheck policy', () => {
  it('allows students to request rechecks only on their own reports', () => {
    expect(canRequestRecheckForReport({
      viewerRole: 'student',
      viewerUsername: 'student_a',
      reportUsername: 'student_a',
    })).toBe(true);
    expect(canRequestRecheckForReport({
      viewerRole: 'student',
      viewerUsername: 'student_a',
      reportUsername: 'student_b',
    })).toBe(false);
    expect(canRequestRecheckForReport({
      viewerRole: 'student',
      viewerUsername: 'student_a',
    })).toBe(false);
  });

  it('denies teachers the ability to request rechecks', () => {
    expect(canRequestRecheckForReport({
      viewerRole: 'teacher',
      viewerSchool: 'Alpha School',
      reportUsername: 'student_a',
      reportSchool: 'Alpha School',
    })).toBe(false);
  });

  it('enforces school tenancy for admins', () => {
    expect(canRequestRecheckForReport({
      viewerRole: 'admin',
      viewerSchool: 'Alpha School',
      reportUsername: 'student_a',
      reportSchool: 'Alpha School',
    })).toBe(true);
    expect(canRequestRecheckForReport({
      viewerRole: 'admin',
      viewerSchool: 'Alpha School',
      reportUsername: 'student_b',
      reportSchool: 'Beta School',
    })).toBe(false);
  });

  it('allows admins to request rechecks when school metadata is missing', () => {
    expect(canRequestRecheckForReport({
      viewerRole: 'admin',
      viewerSchool: 'Alpha School',
      reportUsername: 'student_a',
    })).toBe(true);
  });

  it('allows skyll_admin to request rechecks on any valid report', () => {
    expect(canRequestRecheckForReport({
      viewerRole: 'skyll_admin',
      reportUsername: 'student_b',
      reportSchool: 'Beta School',
    })).toBe(true);
    
    expect(canRequestRecheckForReport({
      viewerRole: 'skyll_admin',
    })).toBe(false); // missing reportUsername
  });

  it('replaces the form state with the server request returned by a duplicate 409', () => {
    const existing = [{ id: 'old', status: 'resolved' }, { id: 'active', status: 'open' }];
    const server = { id: 'active', status: 'in_review', reason: 'Server-authoritative reason' };
    expect(mergeRecheckResponse(existing, server)).toEqual([
      server,
      { id: 'old', status: 'resolved' },
    ]);
  });
});
