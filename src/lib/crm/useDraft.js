// An editable copy of a value the server owns (a stage name, a settings form).
//
// The usual `useEffect(() => setDraft(value), [value])` also runs once after the
// first paint, and if the person (or a test) edits before React flushes that
// effect, the edit is overwritten with the server value. That was the flaky
// CRM tests in #397. Here the draft resets during render, and only when the
// value actually changes (react.dev: "Adjusting some state when a prop changes").
import { useState } from 'react';

export function useDraft(value, toDraft = (current) => current) {
  const [source, setSource] = useState(value);
  const [draft, setDraft] = useState(() => toDraft(value));
  if (!Object.is(source, value)) {
    setSource(value);
    setDraft(toDraft(value));
  }
  return [draft, setDraft];
}
