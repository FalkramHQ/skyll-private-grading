// Fee rules shared by the CRM server and UI (CRM M2 phase 1, D2–D6). Money is
// always whole paise (integers); dates are school-local `YYYY-MM-DD`.
import { z } from 'zod';
import { dateOnly } from './classes.js';

export const PLAN_KINDS = Object.freeze(['one_time', 'instalments', 'monthly']);
export const PLAN_KIND_LABELS = Object.freeze({ one_time: 'One-time', instalments: 'Instalments', monthly: 'Monthly' });
export const DUE_UNITS = Object.freeze(['days', 'months']);

/** At most two years of monthly invoices are created up front (D3). */
export const MAX_MONTHS = 24;

const RUPEES = /^\d{1,3}(,\d{2,3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/;

/** "12,000.50" → 1200050. Null for anything that isn't a plain non-negative amount. */
export function rupeesToPaise(value) {
  const text = String(value ?? '').trim();
  if (!RUPEES.test(text)) return null;
  const [whole, fraction = ''] = text.replace(/,/g, '').split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** Paise → "12,000" or "12,000.50" (Indian grouping, no currency sign). */
export function paiseToRupees(paise) {
  const value = Number(paise || 0) / 100;
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 }).format(value);
}

/** "₹12,000". */
export function formatMoney(paise) {
  return `₹${paiseToRupees(paise)}`;
}

/** The Indian financial year (April–March) of a local date: '2026-27'. */
export function financialYear(date) {
  const [year, month] = date.split('-').map(Number);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

function parts(date) {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
}

function iso(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `date` plus `months`, clamped to the end of a shorter month (31 Jan + 1 → 28 Feb). */
export function addMonthsClamped(date, months) {
  const { year, month, day } = parts(date);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const y = target.getUTCFullYear();
  const m = target.getUTCMonth() + 1;
  return iso(y, m, Math.min(day, daysInMonth(y, m)));
}

function addDaysTo(date, days) {
  const { year, month, day } = parts(date);
  return iso(year, month, day + days);
}

const monthLabel = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * The invoices a plan makes from `startDate`: items grouped by due date (one
 * invoice per date, D2), plus one per month for monthly plans. Sorted by date.
 */
export function schedulePreview(plan, startDate) {
  const byDate = new Map();
  const add = (dueDate, line) => {
    if (!byDate.has(dueDate)) byDate.set(dueDate, []);
    byDate.get(dueDate).push(line);
  };
  for (const item of plan.items || []) {
    const due = item.dueOffsetUnit === 'days' ? addDaysTo(startDate, Number(item.dueOffsetValue)) : addMonthsClamped(startDate, Number(item.dueOffsetValue));
    add(due, { label: item.label, amountPaise: Number(item.amountPaise) });
  }
  if (plan.kind === 'monthly' && plan.monthly) {
    const { year, month, day } = parts(startDate);
    const dueDay = Number(plan.monthly.dueDay);
    // The first month is this month if its due day hasn't passed yet.
    let first = { year, month };
    if (day > dueDay) {
      const next = new Date(Date.UTC(year, month, 1));
      first = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
    }
    for (let index = 0; index < Number(plan.monthly.count); index += 1) {
      const target = new Date(Date.UTC(first.year, first.month - 1 + index, 1));
      const y = target.getUTCFullYear();
      const m = target.getUTCMonth() + 1;
      add(iso(y, m, dueDay), { label: `Tuition: ${monthLabel.format(target)}`, amountPaise: Number(plan.monthly.amountPaise) });
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dueDate, lines]) => ({ dueDate, lines, totalPaise: lines.reduce((sum, line) => sum + line.amountPaise, 0) }));
}

export function planTotal(plan) {
  return schedulePreview(plan, '2026-04-01').reduce((sum, invoice) => sum + invoice.totalPaise, 0);
}

const id = z.string().trim().min(1).max(128);
export const paise = z.number({ error: 'Enter an amount' }).int('Whole paise only').positive('Must be more than zero').max(100_000_000_00, 'Too large');

const planItem = z.object({
  label: z.string().trim().min(1, 'Name this charge').max(80),
  amountPaise: paise,
  dueOffsetValue: z.coerce.number().int().min(0).max(730),
  dueOffsetUnit: z.enum(DUE_UNITS),
}).strict().refine((item) => item.dueOffsetUnit === 'days' || item.dueOffsetValue <= 24, { message: 'At most 24 months', path: ['dueOffsetValue'] });

const monthly = z.object({
  amountPaise: paise,
  count: z.coerce.number().int().min(1).max(MAX_MONTHS, `At most ${MAX_MONTHS} months`),
  dueDay: z.coerce.number().int().min(1).max(28, 'Use a day from 1 to 28'),
}).strict();

const planFields = {
  name: z.string().trim().min(1, 'Name the plan').max(120),
  courseId: id.nullable().optional(),
  kind: z.enum(PLAN_KINDS),
  items: z.array(planItem).max(24),
  monthly: monthly.nullable().optional(),
  description: z.string().trim().max(300).optional(),
};

const planShape = (body) => (body.kind === 'monthly' ? Boolean(body.monthly) : body.items.length > 0 && !body.monthly);
const planShapeMessage = { message: 'Add at least one charge (or monthly fee details for a monthly plan)', path: ['items'] };

export const planBody = z.object(planFields).strict().refine(planShape, planShapeMessage);
export const updatePlanBody = z.object({ planId: id, expectedVersion: z.coerce.number().int().positive(), ...planFields }).strict().refine(planShape, planShapeMessage);

export const feeSettingsBody = z.object({
  prefix: z.string().trim().regex(/^[A-Z0-9]{2,8}$/, '2–8 capital letters or digits'),
  headerName: z.string().trim().min(1, 'Enter the name printed on fee documents').max(120),
  headerAddress: z.string().trim().max(300).optional(),
  headerPhone: z.string().trim().max(40).optional(),
  headerGstin: z.string().trim().max(20).optional(),
  footerNote: z.string().trim().max(300).optional(),
  expectedVersion: z.coerce.number().int().min(0),
}).strict();

export { dateOnly };

// ---------------------------------------------------------------- invoices --

/** At most this many invoices from one Add fees (24 months + one-time items). */
export const MAX_INVOICES_PER_APPLY = 48;

export const invoiceLine = z.object({
  label: z.string().trim().min(1, 'Name this charge').max(80),
  amountPaise: paise,
}).strict();

const lines = z.array(invoiceLine).min(1, 'Add at least one charge').max(24);
const voidReason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(280);

// Fee dates stay within a sane window, so a typo can't bill the year 9999.
export const feeDate = dateOnly.refine((value) => value >= '2000-01-01' && value <= '2100-12-31', 'Enter a date between 2000 and 2100');

export const proposedInvoice = z.object({ dueDate: feeDate, lines }).strict();

// `batchId`: the batch the student just joined (S5), whose start the dates count from.
export const previewQuery = z.object({ studentId: id, planId: id, startDate: dateOnly.optional(), batchId: z.string().trim().max(128).optional() });

export const applyBody = z.object({
  studentId: id,
  planId: id,
  startDate: dateOnly,
  invoices: z.array(proposedInvoice).min(1, 'Keep at least one invoice').max(MAX_INVOICES_PER_APPLY),
}).strict()
  // D2: one invoice per due date.
  .refine((body) => new Set(body.invoices.map((invoice) => invoice.dueDate)).size === body.invoices.length, { message: 'Two invoices share a due date; merge them into one', path: ['invoices'] });

export const manualInvoiceBody = z.object({ studentId: id, dueDate: feeDate, lines }).strict();
export const voidInvoiceBody = z.object({ invoiceId: id, reason: voidReason }).strict();
export const correctInvoiceBody = z.object({ invoiceId: id, reason: voidReason, dueDate: feeDate, lines }).strict();
export const stopFutureBody = z.object({ studentId: id, fromDate: dateOnly, reason: voidReason }).strict();

export const DUES_FILTERS = Object.freeze(['overdue', 'week', 'all']);
export const DUES_FILTER_LABELS = Object.freeze({ overdue: 'Overdue', week: 'Due in 7 days', all: 'All unpaid' });
export const duesQuery = z.object({
  filter: z.enum(DUES_FILTERS).default('all'),
  batchId: z.string().max(128).optional(),
  courseId: z.string().max(128).optional(),
});

export const PAYMENT_STATUS_LABELS = Object.freeze({ unpaid: 'Unpaid', partly_paid: 'Partly paid', paid: 'Paid', void: 'Void' });

/** Computed, never stored (D4): payment status and overdue, from the paid amount and school-local today. */
export function invoiceState({ status, totalPaise, paidPaise = 0, dueDate }, today) {
  if (status === 'void') return { paymentStatus: 'void', balancePaise: 0, overdue: false };
  const balancePaise = Math.max(0, totalPaise - paidPaise);
  const paymentStatus = balancePaise === 0 ? 'paid' : paidPaise > 0 ? 'partly_paid' : 'unpaid';
  return { paymentStatus, balancePaise, overdue: balancePaise > 0 && dueDate < today };
}

export function linesTotal(items) {
  return items.reduce((sum, line) => sum + Number(line.amountPaise || 0), 0);
}

// ---------------------------------------------------------------- payments --

export const PAYMENT_METHODS = Object.freeze(['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other']);
export const PAYMENT_METHOD_LABELS = Object.freeze({ cash: 'Cash', upi: 'UPI', bank_transfer: 'Bank transfer', cheque: 'Cheque', card: 'Card', other: 'Other' });

const allocation = z.object({ invoiceId: id, amountPaise: paise }).strict();

export const recordPaymentBody = z.object({
  studentId: id,
  amountPaise: paise,
  receivedOn: dateOnly,
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(80).optional(),
  payerName: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
  // Omitted: oldest due first. Anything left over becomes credit.
  allocations: z.array(allocation).max(MAX_INVOICES_PER_APPLY).optional(),
}).strict()
  .refine((body) => !body.allocations || linesTotal(body.allocations) <= body.amountPaise, { message: 'Allocated more than the payment', path: ['allocations'] })
  .refine((body) => !body.allocations || new Set(body.allocations.map((item) => item.invoiceId)).size === body.allocations.length, { message: 'Each invoice once', path: ['allocations'] });

export const reversePaymentBody = z.object({ paymentId: id, reason: voidReason }).strict();

/** Moves part of a payment between invoices; no `from` takes it from credit, no `to` returns it to credit. */
export const moveAllocationBody = z.object({
  paymentId: id,
  fromInvoiceId: id.nullable().optional(),
  toInvoiceId: id.nullable().optional(),
  amountPaise: paise,
  reason: voidReason,
}).strict()
  .refine((body) => (body.fromInvoiceId || body.toInvoiceId) && body.fromInvoiceId !== body.toInvoiceId, { message: 'Choose two different places', path: ['toInvoiceId'] });

export const paymentsQuery = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
});

/** Oldest due first (D5): `[{ invoiceId, amountPaise }]` for open invoices sorted by due date. */
export function oldestFirst(invoices, amountPaise) {
  let left = amountPaise;
  const result = [];
  for (const invoice of invoices) {
    if (left <= 0) break;
    const take = Math.min(left, invoice.balancePaise);
    if (take > 0) {
      result.push({ invoiceId: invoice.id, amountPaise: take });
      left -= take;
    }
  }
  return result;
}
