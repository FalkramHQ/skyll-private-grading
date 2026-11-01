// @vitest-environment node
// Every serverless function must load under plain Node ESM, the way Vercel runs
// it. Vitest and the Vite build quietly turn a missing named import into
// `undefined`, so #400's `import { detailQuery } from './reports.js'` (never
// exported) passed CI and took down every /api/auth route in production with
// FUNCTION_INVOCATION_FAILED on 2026-10-30.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

function entries(dir) {
  return readdirSync(path.join(root, dir)).flatMap((name) => {
    const relative = path.join(dir, name);
    if (name === '_lib') return [];
    if (statSync(path.join(root, relative)).isDirectory()) return entries(relative);
    return name.endsWith('.js') ? [relative] : [];
  });
}

describe('serverless functions', () => {
  it.each(entries('api'))('%s loads under plain Node', (file) => {
    const load = () => execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(`./${file}`)})`], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
    expect(load).not.toThrow();
  }, 40_000);
});
