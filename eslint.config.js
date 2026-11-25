export default [
  { ignores: ['node_modules/**', '.bot-data/**', 'coverage/**'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: Object.fromEntries([
        'AbortController', 'AbortSignal', 'Buffer', 'clearInterval', 'clearTimeout', 'console', 'fetch',
        'process', 'queueMicrotask', 'Request', 'Response', 'ReadableStream', 'URL', 'setInterval', 'setTimeout',
      ].map((name) => [name, 'readonly'])),
    },
    rules: {
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-fallthrough': 'error',
      'no-unreachable': 'error',
      'no-undef': 'error',
      'no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
      'prefer-const': 'error',
    },
  },
];
