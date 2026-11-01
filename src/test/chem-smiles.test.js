import { describe, expect, it } from 'vitest';
import {
  isLikelySmiles,
  shouldDrawStructure,
  splitReactionMolecules,
  splitTextWithSmiles,
} from '../lib/chemSmiles';

describe('chemSmiles detection', () => {
  it('recognizes aromatic / carbonyl SMILES from VL dumps', () => {
    expect(isLikelySmiles('c1ccccc1CC(=O)C')).toBe(true);
    expect(isLikelySmiles('C1CCCCC1=O')).toBe(true);
    expect(isLikelySmiles('benzoic acid')).toBe(false);
    expect(isLikelySmiles('oxidation')).toBe(false);
  });

  it('only draws rings, aromatics, and multi-step reactions', () => {
    expect(shouldDrawStructure('c1ccccc1CC(=O)C')).toBe(true);
    expect(shouldDrawStructure('C1CCCCC1=O')).toBe(true);
    expect(shouldDrawStructure('C1=CCCCC1.C2=CCCCC2>O3>C12OOC(C1)C2')).toBe(true);
    expect(shouldDrawStructure('C(Cl)')).toBe(false);
    expect(shouldDrawStructure('ClCH2CH=CHCH2CH3')).toBe(false);
    expect(shouldDrawStructure('CH3CH=CHCH2CH2Cl')).toBe(false);
  });

  it('splits messy reaction SMILES into drawable molecules', () => {
    const raw = 'C1=CCCCC1.C2=CCCCC2>O3>C12OOC(C1)C2>Zn/H2O>2 C1CCCCC1=O + ZnO';
    const mols = splitReactionMolecules(raw);
    expect(mols).toContain('C1=CCCCC1');
    expect(mols).toContain('C1CCCCC1=O');
    expect(mols.some((m) => m.includes('cccc')) || mols.includes('C2=CCCCC2')).toBe(true);
  });

  it('replaces SMILES tokens with chem segments inside student answer text', () => {
    const text = [
      'ii) Aromatic ketones. Examples: c1ccccc1CC(=O)C , c1ccccc1CC(=O)C',
      'iii) C1=CCCCC1.C2=CCCCC2>O3>C12OOC(C1)C2>Zn/H2O>2 C1CCCCC1=O + ZnO',
    ].join('\n');
    const segments = splitTextWithSmiles(text);
    const chem = segments.filter((s) => s.type === 'smiles');
    expect(chem.length).toBeGreaterThanOrEqual(2);
    expect(chem.some((s) => s.value.includes('c1ccccc1'))).toBe(true);
    expect(chem.some((s) => s.value.includes('>'))).toBe(true);
    expect(segments.some((s) => s.type === 'text' && /Aromatic ketones/.test(s.value))).toBe(true);
  });

  it('keeps simple halides and LaTeX-wrapped tokens as plain text', () => {
    const text = 'i) \\text{CH}_3\\text{C(Cl)} = CHCH_2CH_3 < CH_3CH = CHCH_2CH_2Cl';
    const segments = splitTextWithSmiles(text);
    expect(segments).toEqual([{ type: 'text', value: text }]);
  });
});
