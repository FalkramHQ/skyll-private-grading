// FLKRM-487: invoice formatting shared by the PDF and the admin page.
import { describe, expect, it } from 'vitest';
import { formatINR, formatLineRate, invoicePdfFilename, longDate, periodLabel, shortDate } from '../../shared/invoiceFormat.js';

describe('shared invoice formatting', () => {
  it('groups rupees the Indian way, from paise', () => {
    expect(formatINR(12337500)).toBe('1,23,375.00');
    expect(formatINR(625)).toBe('6.25');
    expect(formatINR(-25)).toBe('-0.25');
    expect(formatINR(null)).toBe('0.00');
  });

  it('labels months and dates in IST-independent UTC', () => {
    expect(periodLabel('2026-09')).toBe('September 2026');
    expect(shortDate('2026-09-05')).toBe('5 Sept 2026');
    expect(shortDate('2026-10-03T05:00:00.000Z')).toBe('3 Oct 2026');
    expect(shortDate(null)).toBe('—');
    expect(longDate('2026-10-02')).toBe('2 October 2026');
  });

  it('names the PDF after the SKY number', () => {
    expect(invoicePdfFilename('SKY/2026-27/0001')).toBe('SKY-2026-27-0001.pdf');
  });

  it('formats the rate column for default and banded lines', () => {
    expect(formatLineRate({ ratePaisePerMark: 25, pricePaisePerPaper: null })).toBe('₹0.25 / mark');
    expect(formatLineRate({ ratePaisePerMark: null, pricePaisePerPaper: 2250 })).toBe('₹22.50 / paper');
  });
});
