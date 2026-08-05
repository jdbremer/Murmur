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

  // Prettier last: turn off stylistic rules it owns.
  prettier,
)
