// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Regras escolhidas pelo que elas pegam neste produto, nao por completude.
 *
 * O foco e em erro silencioso: promise nao aguardada num handler HTTP vira
 * resposta enviada antes do commit; `any` numa borda de IO apaga toda a
 * validacao que o Zod fez; `==` entre id e numero vira comparacao verdadeira
 * por coercao. O resto fica a cargo do compilador em modo strict.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.data/**',
      '**/test-results/**',
      '**/*.tsbuildinfo',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Promise ignorada e a principal fonte de bug sutil em servidor Node.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // `any` apaga a validacao de entrada; `unknown` + parse e o caminho.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
      'prefer-const': 'error',
      'no-restricted-syntax': [
        'error',
        {
          // Segredo nunca vai para o cliente nem para o log por descuido.
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env'][property.name=/SECRET|PASSWORD|TOKEN|KEY/]:not(:has(CallExpression))",
          message:
            'Leia segredos pelo modulo de configuracao validada (apps/api/src/config.ts), nao direto de process.env.',
        },
      ],
    },
  },
  {
    // Testes exercitam entradas invalidas de proposito.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Scripts de manutencao rodam em Node puro, fora do programa TypeScript.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        crypto: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
);
