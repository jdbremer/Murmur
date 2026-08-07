import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      '**/build/**',
      'packages/native/build/**',
      // Sidecar source checkouts (scripts/sidecars/build-*.sh) carry their own
      // eslint configs, which must never be resolved against our node_modules.
      '.sidecars/**',
    ],
  },

  // Base JS rules everywhere.
  js.configs.recommended,

  // TypeScript sources (syntax-aware, not type-aware — keeps lint fast and
  // independent of build state; `npm run typecheck` is the type-level gate).
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx,mts,cts}'],
  })),
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Electron main + preload: Node environment.
  {
    files: ['apps/desktop/src/{main,preload}/**/*.ts', 'apps/desktop/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Renderers: browser environment + React hooks rules.
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  // The capture AudioWorklet runs in AudioWorkletGlobalScope, not on the main
  // thread, so it sees neither `window` nor the DOM — just these three globals
  // the spec puts in scope. It is plain JS because it is loaded by URL through
  // `audioWorklet.addModule` rather than bundled into the page.
  {
    files: ['apps/desktop/src/renderer/audio/capture-processor.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly',
        currentTime: 'readonly',
        currentFrame: 'readonly',
      },
    },
  },

  // Shared package is platform-neutral; only needs the console/process shims it guards for.
  {
    files: ['packages/shared/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // Plain-JS bits: the native wrapper (CJS, no build step) and config files.
  {
    files: ['packages/native/**/*.js', '*.mjs', '*.cjs'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
    },
  },
  {
    files: ['*.mjs', 'eslint.config.mjs'],
    languageOptions: { sourceType: 'module' },
  },

  // Repo tooling scripts (the agent driver, sidecar fetchers): plain Node ESM.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node }, sourceType: 'module' },
  },

  // The one tooling script that cannot be ESM: it is loaded by `npx electron`,
  // whose main process is CommonJS.
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: { globals: { ...globals.node }, sourceType: 'commonjs' },
  },

  // Prettier last: turn off stylistic rules it owns.
  prettier,
)
