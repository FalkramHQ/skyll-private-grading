import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    clearMocks: true,
    // The Expo app owns its Jest suite and preset; do not run it under Vitest.
    // Local Git worktrees and agent workspaces (.kilo, .worktrees) may contain
    // their own tests and dependencies. They are separate checkouts, not part
    // of this application's test surface.
    exclude: ['apps/intake/**', '.tmp/**', '.tmp-npm-cache/**', '.worktrees/**', '.kilo/**', '.claude/**', 'node_modules/**', 'dist/**'],
    // With CI unavailable the local run is the gate, and it often shares a
    // busy laptop. Generous limits keep slow-but-correct tests from failing.
    testTimeout: 15_000,
    hookTimeout: 30_000,
    environmentOptions: {
      jsdom: { url: 'http://localhost' },
    },
  },
});
