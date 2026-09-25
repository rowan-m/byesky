import eslint from '@eslint/js';
import securityPlugin from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';

export default [
  eslint.configs.recommended,
  securityPlugin.configs.recommended,
  sonarjs.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        // Browser globals
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        indexedDB: 'readonly',
        Event: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        alert: 'readonly',
        AbortController: 'readonly',
        DOMException: 'readonly',
        Headers: 'readonly',
        // Node globals
        process: 'readonly',
        global: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'warn',
      'no-console': 'off',
      'security/detect-object-injection':
        'off' /* Off for state-management property access lookup */,
      'sonarjs/cognitive-complexity':
        'off' /* Disabled to prevent legacy UI controller complexity errors */,
      'sonarjs/pseudo-random': 'off' /* Allowed for non-crypto UI backoff/jitter calculations */,
      'sonarjs/no-nested-conditional': 'warn' /* Warn for nesting rather than erroring */,
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'cache/**'],
  },
];
