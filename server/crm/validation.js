// Shared request validation. Handlers declare zod schemas; nothing re-implements
// field checks per handler.
import { crmErrors } from './errors.js';

export function parseInput(schema, value) {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  throw crmErrors.validation(parsed.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  })));
}
