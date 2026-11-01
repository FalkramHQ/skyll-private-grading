// Fee rules (CRM M2 phase 1, D3/D6): money in paise, the financial year,
// and the schedule a fee plan produces from a start date.
import { describe, expect, it } from 'vitest';
import {
  addMonthsClamped, feeSettingsBody, financialYear, planBody, rupeesToPaise, schedulePreview,
} from '../../../shared/crm/fees.js';

describe('money and dates', () => {
  it('turns typed rupees into whole paise and refuses junk', () => {
    expect(rupeesToPaise('12000')).toBe(1_200_000);
    expect(rupeesToPaise('12,000.50')).toBe(1_200_050);
    expect(rupeesToPaise('0.5')).toBe(50);
    expect(rupeesToPaise('1.234')).toBeNull();
    expect(rupeesToPaise('-5')).toBeNull();
    expect(rupeesToPaise('abc')).toBeNull();
  });

  it('works out the Indian financial year (April to March)', () => {
    expect(financialYear('2026-04-01')).toBe('2026-27');
    expect(financialYear('2027-03-31')).toBe('2026-27');
    expect(financialYear('2026-03-31')).toBe('2025-26');
  });

  it('adds months, keeping to the end of shorter months', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2026-06-15', 4)).toBe('2026-10-15');
    expect(addMonthsClamped('2026-11-30', 3)).toBe('2027-02-28');
  });
});

describe('schedulePreview', () => {
  const instalments = {
    kind: 'instalments',
    items: [
      { label: 'Admission fee', amountPaise: 200_000, dueOffsetValue: 0, dueOffsetUnit: 'months' },
      { label: 'Instalment 1', amountPaise: 1_200_000, dueOffsetValue: 0, dueOffsetUnit: 'months' },
      { label: 'Instalment 2', amountPaise: 1_200_000, dueOffsetValue: 4, dueOffsetUnit: 'months' },
      { label: 'Instalment 3', amountPaise: 1_200_000, dueOffsetValue: 7, dueOffsetUnit: 'months' },
    ],
  };

  it('groups items due on the same date into one invoice, in date order', () => {
    expect(schedulePreview(instalments, '2026-06-15')).toEqual([
      { dueDate: '2026-06-15', lines: [{ label: 'Admission fee', amountPaise: 200_000 }, { label: 'Instalment 1', amountPaise: 1_200_000 }], totalPaise: 1_400_000 },
      { dueDate: '2026-10-15', lines: [{ label: 'Instalment 2', amountPaise: 1_200_000 }], totalPaise: 1_200_000 },
      { dueDate: '2027-01-15', lines: [{ label: 'Instalment 3', amountPaise: 1_200_000 }], totalPaise: 1_200_000 },
    ]);
  });

  it('supports day offsets', () => {
    const plan = { kind: 'one_time', items: [{ label: 'Kit', amountPaise: 50_000, dueOffsetValue: 10, dueOffsetUnit: 'days' }] };
    expect(schedulePreview(plan, '2026-12-25')[0].dueDate).toBe('2027-01-04');
  });

  it('makes monthly invoices on the due day, starting this month if the day has not passed', () => {
    const plan = {
      kind: 'monthly',
      monthly: { amountPaise: 300_000, count: 3, dueDay: 10 },
      items: [{ label: 'Admission fee', amountPaise: 100_000, dueOffsetValue: 0, dueOffsetUnit: 'days' }],
    };
    const fromEarly = schedulePreview(plan, '2026-06-05');
    expect(fromEarly.map((invoice) => invoice.dueDate)).toEqual(['2026-06-05', '2026-06-10', '2026-07-10', '2026-08-10']);
    expect(fromEarly[1].lines).toEqual([{ label: 'Tuition: June 2026', amountPaise: 300_000 }]);
    const fromLate = schedulePreview({ ...plan, items: [] }, '2026-06-20');
    expect(fromLate.map((invoice) => invoice.dueDate)).toEqual(['2026-07-10', '2026-08-10', '2026-09-10']);
  });
});

describe('schemas', () => {
  const base = { name: 'Grade 10 Maths tuition', kind: 'instalments', items: [{ label: 'Instalment 1', amountPaise: 1_200_000, dueOffsetValue: 0, dueOffsetUnit: 'months' }] };

  it('accepts sensible plans and refuses empty or inconsistent ones', () => {
    expect(planBody.safeParse(base).success).toBe(true);
    expect(planBody.safeParse({ ...base, items: [] }).success).toBe(false);
    expect(planBody.safeParse({ ...base, kind: 'monthly' }).success).toBe(false);
    expect(planBody.safeParse({ ...base, kind: 'monthly', items: [], monthly: { amountPaise: 300_000, count: 12, dueDay: 5 } }).success).toBe(true);
    expect(planBody.safeParse({ ...base, kind: 'monthly', items: [], monthly: { amountPaise: 300_000, count: 25, dueDay: 5 } }).success).toBe(false);
    expect(planBody.safeParse({ ...base, kind: 'monthly', items: [], monthly: { amountPaise: 300_000, count: 3, dueDay: 31 } }).success).toBe(false);
    expect(planBody.safeParse({ ...base, items: [{ ...base.items[0], amountPaise: 0 }] }).success).toBe(false);
    expect(planBody.safeParse({ ...base, items: [{ ...base.items[0], amountPaise: 12.5 }] }).success).toBe(false);
  });

  it('checks the document prefix', () => {
    expect(feeSettingsBody.safeParse({ prefix: 'SDS', headerName: 'Skyll Demo School', expectedVersion: 0 }).success).toBe(true);
    expect(feeSettingsBody.safeParse({ prefix: 'sd', headerName: 'X', expectedVersion: 0 }).success).toBe(false);
    expect(feeSettingsBody.safeParse({ prefix: 'S/D', headerName: 'X', expectedVersion: 0 }).success).toBe(false);
  });
});
