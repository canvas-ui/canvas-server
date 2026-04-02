import js from '@eslint/js';
import globals from 'globals';

const IGNORE_PATTERNS = [
    'node_modules/**',
    'coverage/**',
    'dist/**',
    'build/**',
    '.cursor/**',
    'extensions/browser-extensions/**',
    'src/ui/**',
    'src/services/synapsd/**',
];

export default [
    {
        ignores: IGNORE_PATTERNS,
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        ignores: IGNORE_PATTERNS,
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.es2024,
            },
        },
        rules: {
            'no-console': 'off',
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],
            'no-case-declarations': 'warn',
            'no-empty': 'warn',
            'no-setter-return': 'warn',
            'no-undef': 'warn',
            'no-unused-private-class-members': 'warn',
            'no-useless-assignment': 'warn',
            'no-useless-catch': 'warn',
            'preserve-caught-error': 'warn',
            'require-yield': 'warn',
        },
    },
    {
        files: ['**/*.test.js'],
        ignores: IGNORE_PATTERNS,
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.mocha,
            },
        },
    },
];
