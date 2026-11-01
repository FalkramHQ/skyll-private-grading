import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import MathText from '../components/MathText';

describe('question table rendering', () => {
  afterEach(cleanup);

  it('keeps OCR row breaks when rendering an original question', () => {
    render(
      <MathText
        block
        stripJargon={false}
        text={[
          'Their balance sheet was as follows:',
          '| Liabilities | Rs | Assets | Rs |',
          '| Creditors | 58,000 | Cash | 8,000 |',
          '| Total | 4,80,000 | Total | 4,80,000 |',
        ].join('\n')}
      />,
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Liabilities')).toBeInTheDocument();
    expect(screen.getAllByText('4,80,000')).toHaveLength(2);
  });

  it('renders a student transcript with an existing divider row as a table', () => {
    render(
      <MathText
        block
        stripJargon={false}
        text={[
          'Balance Sheet',
          '| Liabilities | Amount | Assets | Amount |',
          '| --- | --- | --- | --- |',
          '| Creditors | 70,000 | Cash | 8,000 |',
        ].join('\n')}
      />,
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Creditors')).toBeInTheDocument();
  });
});
