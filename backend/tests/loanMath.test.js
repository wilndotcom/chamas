/**
 * Tests for loanMath.js — the money calculations that must not drift.
 *
 * These cover the interest calculation, rounding, and date handling that every
 * member's balance depends on. A silent change here means a member owes the wrong
 * amount and nothing else in the system would notice.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { decorateLoan, summarise, round2, dateOnly } = require('../utils/loanMath');

// --- round2 ---

test('round2 rounds to two decimal places', () => {
  assert.equal(round2(10.005), 10.01);
  assert.equal(round2(10.004), 10.0);
  assert.equal(round2(10), 10);
  assert.equal(round2(0), 0);
});

test('round2 treats non-numbers as zero rather than throwing', () => {
  // A NaN from a corrupted balance must not propagate through the app.
  assert.equal(round2('abc'), 0);
  assert.equal(round2(null), 0);
  assert.equal(round2(undefined), 0);
});

test('round2 handles negative amounts', () => {
  assert.equal(round2(-10.005), -10.01);
  assert.equal(round2(-10.004), -10.0);
});

// --- dateOnly ---

test('dateOnly formats a Date to YYYY-MM-DD without timezone shift', () => {
  // A Date at midnight local time must not become the previous day.
  const d = new Date(2026, 0, 15); // 15 Jan 2026 local
  assert.equal(dateOnly(d), '2026-01-15');
});

test('dateOnly passes through a valid string unchanged', () => {
  assert.equal(dateOnly('2026-03-09'), '2026-03-09');
});

test('dateOnly returns null for invalid input', () => {
  assert.equal(dateOnly(null), null);
  assert.equal(dateOnly('not-a-date'), null);
  assert.equal(dateOnly(''), null);
  // An invalid Date object must not produce a garbage string.
  assert.equal(dateOnly(new Date('invalid')), null);
});

// --- decorateLoan ---

test('decorateLoan computes flat interest correctly', () => {
  const loan = decorateLoan({
    principal_amount: 10000,
    interest_amount: 1000,
    total_repayable: 11000,
    amount_paid: 0,
    balance: 11000,
    status: 'active'
  });
  assert.equal(loan.principal_amount, 10000);
  assert.equal(loan.interest_amount, 1000);
  assert.equal(loan.total_repayable, 11000);
  assert.equal(loan.balance, 11000);
  assert.equal(loan.interest_outstanding, 1000);
});

test('decorateLoan derives interest outstanding pro rata', () => {
  // Half the balance remains, so half the interest remains outstanding.
  const loan = decorateLoan({
    principal_amount: 10000,
    interest_amount: 1000,
    total_repayable: 11000,
    amount_paid: 5500,
    balance: 5500,
    status: 'active'
  });
  assert.equal(loan.interest_outstanding, 500);
});

test('decorateLoan returns zero interest when fully repaid', () => {
  const loan = decorateLoan({
    principal_amount: 10000,
    interest_amount: 1000,
    total_repayable: 11000,
    amount_paid: 11000,
    balance: 0,
    status: 'active'
  });
  assert.equal(loan.interest_outstanding, 0);
});

test('decorateLoan marks settled loans with zero outstanding', () => {
  const loan = decorateLoan({
    principal_amount: 10000,
    interest_amount: 1000,
    total_repayable: 11000,
    amount_paid: 11000,
    balance: 0,
    status: 'completed'
  });
  assert.equal(loan.is_settled, true);
  assert.equal(loan.interest_outstanding, 0);
  assert.equal(loan.principal_outstanding, 0);
});

test('decorateLoan handles zero interest rate', () => {
  const loan = decorateLoan({
    principal_amount: 5000,
    interest_amount: 0,
    total_repayable: 5000,
    amount_paid: 0,
    balance: 5000,
    status: 'active'
  });
  assert.equal(loan.interest_outstanding, 0);
  assert.equal(loan.total_repayable, 5000);
});

test('decorateLoan computes repaid percentage', () => {
  const loan = decorateLoan({
    principal_amount: 10000,
    interest_amount: 1000,
    total_repayable: 11000,
    amount_paid: 5500,
    balance: 5500,
    status: 'active'
  });
  assert.equal(loan.repaid_percent, 50);
});

// --- summarise ---

test('summarise totals balance, interest and repayable for open loans', () => {
  const loans = [
    { is_open: true, balance: 11000, interest_outstanding: 1000, total_repayable: 11000, amount_paid: 0 },
    { is_open: true, balance: 3000, interest_outstanding: 500, total_repayable: 5500, amount_paid: 2500 }
  ];
  const s = summarise(loans);
  assert.equal(s.total_balance, 14000);
  assert.equal(s.total_repayable, 16500);
  assert.equal(s.amount_paid, 2500);
  assert.equal(s.open_loan_count, 2);
});

test('summarise handles an empty array', () => {
  const s = summarise([]);
  assert.equal(s.total_balance, 0);
  assert.equal(s.total_repayable, 0);
  assert.equal(s.open_loan_count, 0);
});

test('summarise counts open and settled loans', () => {
  const s = summarise([
    { is_open: true, is_settled: false, balance: 1100, interest_outstanding: 100, total_repayable: 1100, amount_paid: 0 },
    { is_open: true, is_settled: false, balance: 2200, interest_outstanding: 200, total_repayable: 2200, amount_paid: 0 },
    { is_open: false, is_settled: true, balance: 0, interest_outstanding: 0, total_repayable: 3300, amount_paid: 3300 }
  ]);
  assert.equal(s.open_loan_count, 2);
  assert.equal(s.settled_loan_count, 1);
});

test('summarise computes repaid percent across open loans', () => {
  const s = summarise([
    { is_open: true, balance: 5500, interest_outstanding: 500, total_repayable: 11000, amount_paid: 5500 }
  ]);
  assert.equal(s.repaid_percent, 50);
});
