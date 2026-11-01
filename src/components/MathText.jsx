import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { formatReportText } from '../lib/textFormat';
import { toStudentFacingText } from '../lib/studentFacingText';
import { splitTextWithSmiles } from '../lib/chemSmiles';
import SmilesStructure from './SmilesStructure';

const GRADING_JARGON = [
  /^\s*Correct:\s*/i,
  /^\s*Rubric:\s*/i,
  /^\s*Required:\s*/i,
  /^\s*Found:\s*/i,
  /^\s*Missing\/Wrong:\s*/i,
  /^\s*Mark split:\s*/i,
  /^\s*Thinking trace:\s*/i,
  /^\s*Turning point:\s*/i,
  /^\s*Error type:\s*/i,
  /^\s*Objective answer mismatch\b/i,
  /^\s*Partial objective match\b/i,
  /^\s*objective answer\/content did not match the key\b/i,
  /^\s*Student wrote the wrong option\b/i,
  /^\s*Mark split: objective answer mismatch\b/i,
];

/**
 * Strip grading pipeline jargon that leaks into student-facing text.
 */
function stripJargon(text) {
  let cleaned = String(text || '');
  for (const pattern of GRADING_JARGON) {
    cleaned = cleaned.replace(pattern, '');
  }
  return toStudentFacingText(cleaned);
}

/**
 * Wrap bare LaTeX commands (without $...$ delimiters) in inline math delimiters
 * so remark-math + rehype-katex can render them.
 * Handles patterns like (\frac{4}{5}), \sqrt{2}, \times, \overline, etc.
 */
function wrapBareLatex(text) {
  let result = String(text);

  // Quick check: any backslash-letter sequences?
  if (!/\\[a-zA-Z]/.test(result)) return result;

  // Walk through text, find \command sequences and wrap them in $...$
  // Extend forward through connected math (operators, digits, more \commands)
  // Don't extend backward - surrounding ( ) stays as plain text

  // Characters that connect math expressions (including parens for \left( \right))
  const connectorChar = /[0-9+\-={}\[\]\^_/*.,\s\\|<>:;()]/;
  const mathOpChar = /[0-9+\-={}\[\]\^_/*.,|<>:;()]/;

  let output = '';
  let i = 0;
  while (i < result.length) {
    // Preserve already-delimited math and normalize only bare LaTex around it.
    if (result[i] === '$') {
      const closingDelimiter = result.indexOf('$', i + 1);
      if (closingDelimiter !== -1) {
        output += result.slice(i, closingDelimiter + 1);
        i = closingDelimiter + 1;
        continue;
      }
    }
    // A whole \begin{env}…\end{env} block is one formula; wrapping its
    // commands one by one splits it and leaves raw LaTeX on screen.
    const environment = /^\\begin\{([a-zA-Z*]+)\}/.exec(result.slice(i));
    if (environment) {
      const end = `\\end{${environment[1]}}`;
      const closing = result.indexOf(end, i);
      if (closing !== -1) {
        output += `$${result.slice(i, closing + end.length)}$`;
        i = closing + end.length;
        continue;
      }
    }
    if (result[i] === '\\' && /[a-zA-Z]/.test(result[i + 1])) {
      let j = i;

      // Consume consecutive \command{...} groups separated by math operators/spaces
      while (j < result.length) {
        if (result[j] === '\\' && /[a-zA-Z]/.test(result[j + 1])) {
          // Consume \command name
          j++; // skip backslash
          while (j < result.length && /[a-zA-Z]/.test(result[j])) j++;
          // Consume any {...} groups
          while (j < result.length && result[j] === '{') {
            let depth = 1;
            j++;
            while (j < result.length && depth > 0) {
              if (result[j] === '{') depth++;
              else if (result[j] === '}') depth--;
              j++;
            }
          }
          // Consume optional space
          while (j < result.length && result[j] === ' ') j++;
        } else if (connectorChar.test(result[j])) {
          // Check if this connector leads to another \command
          let lookAhead = j;
          while (lookAhead < result.length && /\s/.test(result[lookAhead])) lookAhead++;

          if (lookAhead < result.length && result[lookAhead] === '\\' && /[a-zA-Z]/.test(result[lookAhead + 1])) {
            // Another \command ahead - include the connector chars
            j++;
          } else if (mathOpChar.test(result[j])) {
            // Math operator/digit without a following \command
            // Include it only if immediately adjacent (no space before it)
            if (j > 0 && !/\s/.test(result[j - 1])) {
              j++;
            } else {
              break;
            }
          } else {
            break;
          }
        } else {
          break;
        }
      }

      let mathRun = result.slice(i, j);
      // Trim trailing spaces/commas
      mathRun = mathRun.replace(/[\s,]+$/, '');

      output += '$' + mathRun + '$';
      i += mathRun.length;
    } else {
      output += result[i];
      i++;
    }
  }

  // Merge adjacent $...$$...$ 
  output = output.replace(/\$\$(?!\s)/g, '');
  output = output.replace(/(?<!\s)\$\$/g, '');

  // Clean up empty math delimiters
  output = output.replace(/\$\s*\$/g, '');

  return output;
}

function inlineTablePreview(text) {
  const tableStart = text.indexOf('|');
  if (tableStart < 0) return text;
  const lead = text.slice(0, tableStart).trim().replace(/[:;,.]\s*$/, '');
  return `${lead}. Includes a table; open the question to view it.`;
}

function MarkdownChunk({ text, block, className }) {
  if (!text) return null;

  const blockComponents = {
    p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
    li: ({ children }) => <li className="ml-4 list-disc mb-1 leading-relaxed">{children}</li>,
    ul: ({ children }) => <ul className="mb-2 last:mb-0">{children}</ul>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    table: ({ children }) => (
      <div className="my-3 max-w-full overflow-x-auto rounded-[10px] border border-hairline bg-white">
        <table className="w-full min-w-[34rem] border-collapse text-left text-xs leading-relaxed text-foreground tabular-nums">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-sunken text-foreground-secondary">{children}</thead>,
    th: ({ children }) => <th className="border-b border-hairline px-3 py-2 font-semibold">{children}</th>,
    td: ({ children }) => <td className="border-b border-hairline px-3 py-2 align-top last:border-b-0">{children}</td>,
    tr: ({ children }) => <tr className="last:[&>td]:border-b-0">{children}</tr>,
  };
  const inlineComponents = {
    p: ({ children }) => <span className="inline">{children}</span>,
  };
  const Wrapper = block ? 'div' : 'span';

  return (
    <Wrapper className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={block ? blockComponents : inlineComponents}
      >
        {text}
      </ReactMarkdown>
    </Wrapper>
  );
}

/**
 * Render text that may contain:
 *   - LaTeX math (\frac, \sqrt, etc.) via remark-math + rehype-katex
 *   - SMILES chemistry strings as structure diagrams (rings, not ccccc)
 *   - Markdown formatting (**bold**, lists) via react-markdown
 *   - Plain text as a fallback
 *   - Grading jargon is automatically stripped
 *
 * Usage: <MathText text={question.correct_answer} />
 */
function MathText({ text, className = '', stripJargon: strip = true, block = false }) {
  if (!text) return null;
  let safe = String(text).trim();
  if (!safe) return null;
  if (strip) safe = stripJargon(safe);

  const segments = splitTextWithSmiles(safe);
  const hasChem = segments.some((seg) => seg.type === 'smiles');
  if (!hasChem) {
    safe = wrapBareLatex(safe);
    if (block) safe = formatReportText(safe);
    else safe = inlineTablePreview(safe);
    return <MarkdownChunk text={safe} block={block} className={`math-text ${className}`} />;
  }

  const Wrapper = block ? 'div' : 'span';
  return (
    <Wrapper className={`math-text ${className}`}>
      {segments.map((seg, i) => {
        if (seg.type === 'smiles') {
          return <SmilesStructure key={`chem-${i}`} smiles={seg.value} inline={!block} />;
        }
        let chunk = wrapBareLatex(seg.value);
        if (block) chunk = formatReportText(chunk);
        else chunk = inlineTablePreview(chunk);
        if (!String(chunk || '').trim()) return null;
        return <MarkdownChunk key={`txt-${i}`} text={chunk} block={block} />;
      })}
    </Wrapper>
  );
}

// Parsing markdown + KaTeX is the expensive part of every list that shows answers;
// skip it when the text and options are unchanged.
export default memo(MathText);
