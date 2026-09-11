import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Packages that packages/core may never import.
 * packages/core is a PURE TypeScript engine: headless, no React Native, no Expo,
 * no React. The app renders engine output and forwards taps; it never computes a rule.
 * Enforced here and, independently of eslint, by
 * packages/core/src/purity.test.ts (which greps the sources).
 */
const CORE_FORBIDDEN_IMPORT_PATTERNS = [
  'react',
  'react/*',
  'react-dom',
  'react-native',
  'react-native/*',
  'react-native-*',
  '@react-native/*',
  '@react-native-*/*',
  'expo',
  'expo-*',
  '@expo/*',
  '@shopify/react-native-skia',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'apps/mobile/ios/**',
      'apps/mobile/android/**',
      'apps/mobile/.expo/**',
      'tools/coursekit/**',
      'e2e/artifacts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: CORE_FORBIDDEN_IMPORT_PATTERNS,
              message:
                'packages/core is a pure headless engine: no React, React Native or Expo imports (see plan §Architecture).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/mobile/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { console: 'readonly', __DEV__: 'readonly' },
    },
  },
  {
    // Metro, Babel and the Expo config plugins are CommonJS by construction: Metro
    // loads them with `require`, so they cannot be ESM. This is the only place in the
    // tree where `require` is allowed.
    files: ['apps/mobile/*.config.js', 'apps/mobile/plugins/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        __dirname: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['scripts/**/*.ts', '*.config.{ts,mjs}'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  prettier,
);
