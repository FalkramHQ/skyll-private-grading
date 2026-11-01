import { describe, expect, it } from 'vitest';
import { formatReportText } from '../lib/textFormat';

describe('OCR table formatting', () => {
  it('reconstructs separate sparse balance-sheet and profit tables without losing question prose', () => {
    const source = [
      'Balance sheet was as follows:',
      '| Liabilities | Rs | Assets | Rs |',
      '| Creditors | 58,000 | Cash | 8,000 |',
      '| Capital Accounts: | | Less: Provision | 3,000 |',
      '| Total | 4,80,000 | Total | 4,80,000 |',
      'Goodwill is based on average profits:',
      '| Year 2020 | 20,000 (Loss) |',
      '| Year 2021 | 48,000 (Profit) |',
      'Prepare the revised balance sheet.',
    ].join('\n');

    expect(formatReportText(source)).toBe([
      'Balance sheet was as follows:',
      '| Liabilities | Rs | Assets | Rs |',
      '| --- | --- | --- | --- |',
      '| Creditors | 58,000 | Cash | 8,000 |',
      '| Capital Accounts: |  | Less: Provision | 3,000 |',
      '| Total | 4,80,000 | Total | 4,80,000 |',
      'Goodwill is based on average profits:',
      '| Year 2020 | 20,000 (Loss) |',
      '| --- | --- |',
      '| Year 2021 | 48,000 (Profit) |',
      'Prepare the revised balance sheet.',
    ].join('\n'));
  });

  it('does not duplicate an OCR-supplied Markdown divider row', () => {
    const source = [
      'Balance Sheet',
      '| Liabilities | Amount | Assets | Amount |',
      '| --- | --- | --- | --- |',
      '| Creditors | 70,000 | Cash | 8,000 |',
    ].join('\n');

    expect(formatReportText(source)).toBe(source);
  });
});
