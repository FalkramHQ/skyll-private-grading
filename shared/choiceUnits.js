// Which questions a choice-group unit names. Rubric models often write a choice
// rule by whole question ("any four of Q4–Q9") while the rubric stores each part
// (Q4.1, Q4.2…), so the rule matched nothing and the paper totalled 100 instead of
// 80 (PartnerD ICSE Physics, 22 Oct 2026). A unit number matches a question of that
// number first; failing that, a bare question number covers all of its parts.

const fold = (raw) => String(raw || '').trim().toLowerCase().replace(/^q\.?\s*/, '');

/**
 * The whole-question number a part belongs to: "Q4.1", "Q4(a)", "4a", "Q4 (ii)" → "4".
 * Null for a number with no part ("Q4", "Q41").
 */
export function parentQuestionNumber(raw) {
  const match = /^(\d+)\s*(?:[.(_\-\s]|[a-z])/.exec(fold(raw));
  return match ? match[1] : null;
}

/**
 * The question numbers (from `numbers`) that one choice-group member names: an
 * exact match, else those equal to it under `normalize`, else, when the member is
 * a bare question number such as "Q4", every part of that question. Empty when it
 * names nothing.
 */
export function unitQuestionNumbers(member, numbers, normalize) {
  // Exact first: folding drops separators, so "Q4.1" and "Q41" fold alike.
  const plain = (value) => String(value || '').trim().toLowerCase();
  const exact = numbers.filter((number) => plain(number) === plain(member));
  if (exact.length) return exact;
  const key = normalize(member);
  const direct = numbers.filter((number) => normalize(number) === key);
  if (direct.length) return direct;
  const whole = /^\d+$/.exec(fold(member).replace(/[()\s_.-]/g, ''));
  if (!whole) return [];
  return numbers.filter((number) => parentQuestionNumber(number) === whole[0]);
}

const groupMembers = (group) => [
  ...(Array.isArray(group?.units) ? group.units : []).flatMap((unit) => unit?.question_numbers || []),
  ...(Array.isArray(group?.question_numbers) ? group.question_numbers : []),
];

/**
 * Rewrites "N from each section + M more from any section" into one group with
 * per-section minimums. Rubric models encode that ICSE rule as section groups
 * (choose 1 of Q2–Q3, of Q4–Q5, of Q6–Q7) plus a group overlapping them all
 * (choose 1 of Q2–Q7). Scored one by one, the overlapping group threw away all
 * but one answer: 23/32 instead of 58/80 (PartnerD ICSE English Literature,
 * 24 Oct 2026). A group whose members contain other, disjoint groups becomes
 * `choose` = its own count plus theirs, with each inner group kept as an
 * `at_least` minimum. When that would exceed its units, the outer count is
 * read as the total instead. Other groups pass through unchanged.
 */
export function foldNestedChoiceGroups(groups, normalize) {
  const list = Array.isArray(groups) ? groups : [];
  const sets = list.map((group) => new Set(groupMembers(group).map(normalize).filter(Boolean)));
  const parentOf = new Map();
  list.forEach((_, outer) => {
    if (parentOf.has(outer)) return;
    const inner = list.map((__, index) => index).filter((index) => index !== outer
      && !parentOf.has(index)
      && sets[index].size && sets[index].size < sets[outer].size
      && [...sets[index]].every((member) => sets[outer].has(member)));
    const disjoint = inner.every((left, i) => inner.slice(i + 1).every((right) => [...sets[left]].every((member) => !sets[right].has(member))));
    if (inner.length && disjoint) for (const index of inner) parentOf.set(index, outer);
  });
  if (!parentOf.size) return list;
  return list.flatMap((group, index) => {
    if (parentOf.has(index)) return [];
    const inner = [...parentOf].filter(([, outer]) => outer === index).map(([child]) => list[child]);
    if (!inner.length) return [group];
    const minimums = inner.map((child) => ({
      id: String(child?.id || ''),
      choose: Math.max(0, Number(child?.choose) || 0),
      question_numbers: [...new Set(groupMembers(child).map((member) => String(member).trim()).filter(Boolean))],
    }));
    const required = minimums.reduce((sum, minimum) => sum + minimum.choose, 0);
    const own = Math.max(0, Number(group?.choose) || 0);
    const unitCount = Array.isArray(group?.units) && group.units.length ? group.units.length : sets[index].size;
    return [{
      ...group,
      choose: own + required <= unitCount ? own + required : Math.max(own, required),
      at_least: [...(Array.isArray(group?.at_least) ? group.at_least : []), ...minimums],
    }];
  });
}

/**
 * The units a choice group counts, from `ranked` (best first): each `at_least`
 * minimum takes its best units first, then the best of the rest fill `choose`.
 * `inMinimum(unit, minimum)` says whether a unit belongs to a minimum.
 */
export function pickChoiceUnits(ranked, choose, minimums, inMinimum) {
  const picked = new Set();
  for (const minimum of Array.isArray(minimums) ? minimums : []) {
    const have = ranked.filter((unit) => picked.has(unit) && inMinimum(unit, minimum)).length;
    ranked.filter((unit) => !picked.has(unit) && inMinimum(unit, minimum))
      .slice(0, Math.max(0, Number(minimum.choose || 0) - have))
      .forEach((unit) => picked.add(unit));
  }
  for (const unit of ranked) {
    if (picked.size >= choose) break;
    picked.add(unit);
  }
  return ranked.filter((unit) => picked.has(unit));
}
