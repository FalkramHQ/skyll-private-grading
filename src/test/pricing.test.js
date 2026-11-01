// #311: per-school pricing bands — validation and per-paper price lookup.
import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_PAISE_PER_MARK, priceForPaper, validateBands } from '../../api/_lib/pricing.js';

const BANDS = [{ maxMarks: 20, pricePaise: 500 }, { maxMarks: 40, pricePaise: 1000 }, { maxMarks: 70, pricePaise: 1500 }, { maxMarks: 100, pricePaise: 2000 }];

describe('priceForPaper', () => {
  it('uses ₹0.25 per mark when the school has no bands', () => {
    expect(DEFAULT_RATE_PAISE_PER_MARK).toBe(25);
    expect(priceForPaper(25)).toEqual({ amountPaise: 625, ratePaisePerMark: 25, pricePaisePerPaper: null });
    expect(priceForPaper(100, [])).toMatchObject({ amountPaise: 2500 });
  });

  it('takes the first band whose limit covers the total ("up to N")', () => {
    expect(priceForPaper(20, BANDS)).toEqual({ amountPaise: 500, ratePaisePerMark: null, pricePaisePerPaper: 500 });
    expect(priceForPaper(21, BANDS).pricePaisePerPaper).toBe(1000);
    expect(priceForPaper(52, BANDS).pricePaisePerPaper).toBe(1500);
    expect(priceForPaper(100, BANDS).pricePaisePerPaper).toBe(2000);
    expect(priceForPaper(1, BANDS).pricePaisePerPaper).toBe(500);
  });

  it('has no price above the top band', () => {
    expect(priceForPaper(120, BANDS)).toBeNull();
  });
});

describe('validateBands', () => {
  it('sorts by limit and treats empty or missing as the default', () => {
    expect(validateBands([{ maxMarks: 80, pricePaise: 2000 }, { maxMarks: 40, pricePaise: 1000 }]).bands).toEqual([{ maxMarks: 40, pricePaise: 1000 }, { maxMarks: 80, pricePaise: 2000 }]);
    expect(validateBands([]).bands).toEqual([]);
    expect(validateBands(undefined).bands).toEqual([]);
  });

  it.each([
    ['not a list', { maxMarks: 40, pricePaise: 1000 }, 'list'],
    ['a fractional limit', [{ maxMarks: 40.5, pricePaise: 1000 }], 'marks limit'],
    ['a zero limit', [{ maxMarks: 0, pricePaise: 1000 }], 'marks limit'],
    ['a zero price', [{ maxMarks: 40, pricePaise: 0 }], 'price'],
    ['a fractional paise price', [{ maxMarks: 40, pricePaise: 10.5 }], 'price'],
    ['duplicate limits', [{ maxMarks: 40, pricePaise: 1000 }, { maxMarks: 40, pricePaise: 1200 }], 'share the limit'],
    ['more than 10 bands', Array.from({ length: 11 }, (_, i) => ({ maxMarks: (i + 1) * 10, pricePaise: 100 })), 'At most 10'],
  ])('rejects %s', (_label, input, message) => {
    expect(validateBands(input).error).toContain(message);
  });
});
