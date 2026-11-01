/**
 * Map a free-text copilot "action" suggestion to the generator it should fire.
 * Pure function - no network, fully testable.
 */
export function routeCopilotAction(action) {
  const raw = String(action || '');
  const text = raw.toLowerCase();
  if (/(quiz|question set|mcq|practice test)/.test(text)) return { kind: 'quiz-gen', topic: raw };
  if (/(lesson|reteach|teach|plan)/.test(text)) return { kind: 'lesson-plan', topic: raw };
  if (/(intervention|small.group|support group)/.test(text)) return { kind: 'intervention', topic: raw };
  return { kind: 'copilot', topic: raw };
}
