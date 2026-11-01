import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// findBy* waits up to 1s by default, which a busy machine can exceed.
configure({ asyncUtilTimeout: 3000 });

// Node 26 exposes an experimental localStorage getter that returns undefined
// unless a CLI file is configured. Keep browser tests deterministic and
// process-local instead of relying on that host feature.
const values = new Map();
const testLocalStorage = {
  get length() { return values.size; },
  clear() { values.clear(); },
  getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
  key(index) { return [...values.keys()][index] ?? null; },
  removeItem(key) { values.delete(String(key)); },
  setItem(key, value) { values.set(String(key), String(value)); },
};
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: testLocalStorage,
});
