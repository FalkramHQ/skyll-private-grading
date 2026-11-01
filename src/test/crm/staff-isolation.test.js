// The `staff` role is CRM-only. Every non-CRM endpoint must keep it out, so
// this scans all requireUser() calls: role allowlists may never include
// 'staff', and "any signed-in user" calls are limited to a reviewed set.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// Reviewed: flags are non-sensitive; events only records the caller's own
// telemetry; student-context enforces its own role + school check.
const ANY_SIGNED_IN_USER = new Set([
  'server/auth/features.js',
  'server/auth/events.js',
  'api/student-context.js',
]);

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'crm') continue;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

describe('staff role isolation', () => {
  const files = [...sourceFiles('api'), ...sourceFiles('server')].filter((file) => file !== path.join('api', '_lib', 'auth.js'));
  const calls = files.flatMap((file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    return [...text.matchAll(/requireUser\(\s*req\s*,\s*res\s*(?:,\s*([^)]*))?\)/g)].map((match) => ({ file, roles: match[1]?.trim() || null, text }));
  });

  it('finds the non-CRM auth checks to scan', () => {
    expect(calls.length).toBeGreaterThan(30);
  });

  it('never lists staff in a non-CRM role allowlist', () => {
    const allText = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
    // Expand named role constants (possibly defined in another module, possibly
    // spreading other constants) into their literal role lists.
    const expand = (expr, depth = 0) => {
      if (depth > 5 || expr.startsWith('[') === false && !/^[A-Z_]+$/.test(expr)) return expr;
      const literal = expr.startsWith('[') ? expr : allText.match(new RegExp(`\\b${expr}\\s*=\\s*(\\[[^\\]]*\\])`))?.[1];
      expect(literal, `role constant ${expr} must be resolvable`).toBeTruthy();
      return literal.replace(/\.\.\.([A-Z_]+)/g, (_m, name) => expand(name, depth + 1));
    };
    for (const call of calls.filter((entry) => entry.roles)) {
      expect(expand(call.roles), `${call.file}: ${call.roles}`).not.toMatch(/['"]staff['"]/);
    }
  });

  it('allows "any signed-in user" only in reviewed files', () => {
    const open = [...new Set(calls.filter((entry) => !entry.roles).map((entry) => entry.file.split(path.sep).join('/')))];
    expect(open.sort()).toEqual([...ANY_SIGNED_IN_USER].sort());
  });
});
