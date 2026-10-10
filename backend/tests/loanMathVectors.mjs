#!/usr/bin/env node

/**
 * Prints LoanMath results for a fixed set of inputs, so the PHP port can be
 * compared against it byte for byte.
 *
 * A unit test suite proves each implementation is self-consistent. It does not
 * prove they agree with each other - and these two compute figures a member
 * compares against their own record, so a one-cent difference is a real defect.
 * This file removes the gap by feeding both the same inputs.
 *
 * Writes the file itself rather than printing to stdout, because a shell
 * redirect on Windows produces UTF-16 with a byte order mark and PHP's
 * json_decode rejects it - which reads as "invalid JSON" rather than as an
 * encoding problem.
 *
 * Run:  node ../backend/tests/loanMathVectors.mjs [vectors.json]
 *       php tests/LoanMathVectors.php vectors.json
 */

import { decorateLoan, summarise, round2, dateOnly } from '../utils/loanMath.js';
import { writeFileSync } from 'node:fs';

const loans = [
  { principal_amount: 10000, interest_amount: 1000, total_repayable: 11000, amount_paid: 0, balance: 11000, status: 'active' },
  { principal_amount: 10000, interest_amount: 1000, total_repayable: 11000, amount_paid: 5500, balance: 5500, status: 'active' },
  { principal_amount: 10000, interest_amount: 1000, total_repayable: 11000, amount_paid: 11000, balance: 0, status: 'completed' },
  { principal_amount: 5000, interest_amount: 0, total_repayable: 5000, amount_paid: 1250, balance: 3750, status: 'disbursed' },
  // Strings, which is what MySQL actually returns for DECIMAL columns.
  { principal_amount: '10000.00', interest_amount: '1000.00', total_repayable: '11000.00', amount_paid: '5500.00', balance: '5500.00', status: 'active' },
  // The awkward ones.
  { principal_amount: 3333.33, interest_amount: 333.33, total_repayable: 3666.66, amount_paid: 111.11, balance: 3555.55, status: 'active' },
  { principal_amount: 100, interest_amount: 5, total_repayable: 105, amount_paid: 104, balance: 1, status: 'active' },
  { principal_amount: 0, interest_amount: 0, total_repayable: 0, amount_paid: 0, balance: 0, status: 'active' },
  { principal_amount: 20000, interest_amount: 2000, total_repayable: 22000, amount_paid: 22000, balance: 0, status: 'active' },
  { principal_amount: 750, interest_amount: 75, total_repayable: 825, amount_paid: 0, balance: 825, status: 'pending' },
];

const vectors = {
  round2: [10.005, 10.004, 10, 0, 'abc', null, -10.005, -10.004, 1.005, 2.675, 1.115, 1234.5678].map((n) => round2(n)),

  dateOnly: [
    dateOnly('2026-01-15'),
    dateOnly('2026-03-09'),
    dateOnly(null),
    dateOnly('not-a-date'),
    dateOnly(''),
    dateOnly('2026-06-30'),
  ],

  decorate: loans.map(decorateLoan),

  summarise: [
    summarise([]),
    summarise([
      { is_open: true, balance: 11000, interest_outstanding: 1000, total_repayable: 11000, amount_paid: 0 },
      { is_open: true, balance: 3000, interest_outstanding: 500, total_repayable: 5500, amount_paid: 2500 },
    ]),
    summarise(loans.map(decorateLoan)),
  ],
};

const out = process.argv[2] ?? 'vectors.json';
writeFileSync(out, JSON.stringify(vectors, null, 2), 'utf8');
console.log(`wrote ${out}`);