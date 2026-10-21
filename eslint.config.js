import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const moneyMessage = 'Money code uses bigint minor units only (CLAUDE.md rule 3).';
const moneyNames = 'amount|total|tax|tip|service|cents|price|share|net|weight|balance|subtotal';

// Rules shared by every file that touches money.
const moneyRules = [
  { selector: "MemberExpression[object.name='Math']", message: `No Math.* — ${moneyMessage}` },
  {
    selector: 'CallExpression[callee.name=/^(parseFloat|parseInt|Number)$/]',
    message: `No float/number parsing — ${moneyMessage}`,
  },
  {
    selector: "CallExpression[callee.property.name='toFixed']",
    message: `No toFixed — ${moneyMessage}`,
  },
  { selector: 'Literal[raw=/^[0-9]*\\.[0-9]+$/]', message: `No float literals — ${moneyMessage}` },
  {
    selector: `TSPropertySignature[key.name=/${moneyNames}/i] TSNumberKeyword`,
    message: `Amount fields must be bigint, not number — ${moneyMessage}`,
  },
];

const zNumber = "CallExpression[callee.object.name='z'][callee.property.name='number']";

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      'coverage/**',
      '**/node_modules/**',
      'spikes/**',
      'packages/rln-client/src/schema.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  {
    // Pure money code: no number anywhere, not even z.number().
    files: [
      'packages/ledger/src/**/*.ts',
      'packages/shared/src/money.ts',
      'packages/shared/src/canonical.ts',
      'packages/shared/src/ledger-types.ts',
    ],
    ignores: ['**/*.test.ts', 'packages/ledger/src/test/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...moneyRules,
        { selector: zNumber, message: `No z.number() in money schemas — ${moneyMessage}` },
      ],
    },
  },
  {
    // Schemas that also carry indexes, sequence numbers, counts and latencies: z.number() is allowed,
    // except on a property whose name says it is money.
    files: [
      'packages/shared/src/domain.ts',
      'packages/shared/src/events.ts',
      'packages/shared/src/legacy-events.ts',
      'packages/shared/src/views.ts',
      'packages/shared/src/api.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...moneyRules,
        {
          selector: `Property[key.name=/${moneyNames}/i] ${zNumber}`,
          message: `Amount fields must use the money codec, not z.number() — ${moneyMessage}`,
        },
      ],
    },
  },
);
