/**
 * Per-subject grading profiles: the subject's own marking rules, added to every
 * grade and recheck prompt in every calibration mode. One file per subject; edit
 * a subject's rules there.
 *
 * resolveGradingProfile picks the profile from the paper's subject, and from its
 * title where the subject alone is ambiguous (English Literature papers are often
 * tagged "English"). Order matters: the first match wins.
 */
import accounts from './accounts.js';
import biology from './biology.js';
import chemistry from './chemistry.js';
import englishLanguage from './englishLanguage.js';
import englishLiterature from './englishLiterature.js';
import geography from './geography.js';
import german from './german.js';
import hindi from './hindi.js';
import history from './history.js';
import mathematics from './mathematics.js';
import physics from './physics.js';

export const GRADING_PROFILES = Object.freeze([
  englishLiterature,
  englishLanguage,
  hindi,
  german,
  physics,
  chemistry,
  mathematics,
  biology,
  geography,
  history,
  accounts,
]);

export function resolveGradingProfile(subject = '', title = '') {
  const name = String(subject || '').trim();
  const heading = String(title || '');
  if (englishLiterature.matchTitle.test(heading) && /english|literature|^$/i.test(name)) return englishLiterature;
  if (!name) return null;
  return GRADING_PROFILES.find((profile) => profile.match.test(name)) || null;
}

/**
 * True only when the subject's profile opts in with `downwardRecheck: true`. No
 * profile does (Oct 2026): the recheck is off for every subject.
 */
export function downwardRecheckEnabled(subject = '', title = '') {
  return resolveGradingProfile(subject, title)?.downwardRecheck === true;
}

/** The profile's rules as prompt text (leading space), or '' when none applies. */
export function gradingProfileRules(subject = '', title = '') {
  const profile = resolveGradingProfile(subject, title);
  return profile?.rules?.length ? ` ${profile.rules.join(' ')}` : '';
}
