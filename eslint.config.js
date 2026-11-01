import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Local scratch scripts (.tmp-*) and tool folders are never part of the app.
  globalIgnores(['dist', '.vercel', '.kilo', '.claude', '.qoder', '.worktrees', '.tmp', '**/.tmp-*']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^(?:[A-Z_].*|motion)$', argsIgnorePattern: '^(?:[A-Z_].*|i)$' }],
      'no-useless-escape': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    files: ['apps/intake/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ['apps/intake/__tests__/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.jest } },
  },
  {
    files: ['api/**/*.js', 'server/**/*.js', 'shared/**/*.js', 'scripts/**/*.js', 'apps/processing-worker/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
])
