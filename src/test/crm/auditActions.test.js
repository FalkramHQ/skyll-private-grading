import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION_NAMES, buildAuditSummary, maskEmail, maskPhone } from '../../../shared/crm/auditActions.js';

describe('CRM audit summaries', () => {
  it('registers every M0 action, including later finance and attendance ones', () => {
    expect(AUDIT_ACTION_NAMES).toEqual(expect.arrayContaining([
      'lead.stage_changed', 'lead.converted', 'lead.owner_changed', 'enrollment.changed',
      'attendance.corrected', 'invoice.changed', 'payment.changed', 'refund.changed',
      'permission.granted', 'permission.revoked', 'data.exported', 'record.merged',
      'support.session', 'contact.anonymised',
    ]));
  });

  it('drops fields the action does not allow', () => {
    const summary = buildAuditSummary('permission.granted', {
      capability: 'crm.finance.read',
      fullName: 'Asha Rao',
      notes: 'free text',
    });
    expect(summary).toEqual({ capability: 'crm.finance.read' });
  });

  it('rejects secrets outright instead of storing them', () => {
    for (const key of ['token', 'otpCode', 'upiId', 'cardLast4', 'password', 'bankAccount']) {
      expect(() => buildAuditSummary('payment.changed', { from: 'pending', to: 'succeeded', [key]: 'x' }), key).toThrow(/may not include/);
    }
  });

  it('rejects unknown actions and invalid summaries', () => {
    expect(() => buildAuditSummary('lead.deleted', {})).toThrow(/Unknown audit action/);
    expect(() => buildAuditSummary('lead.stage_changed', { toStageId: 'stg_1' })).toThrow(/Invalid lead.stage_changed/);
    expect(() => buildAuditSummary('attendance.corrected', { studentId: 'stu_1', from: 'present', to: 'absent' })).toThrow(/reason/);
  });

  it('caps free-text reasons', () => {
    expect(() => buildAuditSummary('invoice.changed', { change: 'voided', number: 'SDS/INV/2026-27/0001', amountPaise: 100, reason: 'x'.repeat(281) })).toThrow();
  });

  it('masks phone and email values', () => {
    expect(maskPhone('+91 98123 45621')).toBe('91xxxxxxxx21');
    expect(maskPhone('123')).toBe('xxx');
    expect(maskEmail('parent@gmail.com')).toBe('p***@gmail.com');
    expect(maskEmail('not-an-email')).toBe('***');
  });

  it('accepts a complete stage change', () => {
    expect(buildAuditSummary('lead.stage_changed', {
      fromStageId: 'stg_open', toStageId: 'stg_lost', fromCategory: 'open', toCategory: 'lost', reason: 'Chose another centre',
    })).toEqual({
      fromStageId: 'stg_open', toStageId: 'stg_lost', fromCategory: 'open', toCategory: 'lost', reason: 'Chose another centre',
    });
  });
});
