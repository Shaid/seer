import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'node_modules/', 'public/', 'packages/*/dist/'],
  },
  {
    // CLI bin shims are plain Node-executed .mjs, not bundled for the
    // browser — they need Node globals (process, console) but no
    // TypeScript-aware rules since they contain no type annotations.
    files: ['**/bin/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
