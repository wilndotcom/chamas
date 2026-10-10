/**
 * Tests for the M-Pesa phone conversion in mpesaController.js.
 *
 * M-Pesa sends PhoneNumber as 254712345678. Members are stored as 0712345678.
 * If this conversion is wrong, payments are recorded against no member and the
 * money vanishes from the ledger.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// Replicate the conversion logic from mpesaController.js
const normalisePhone = (phone) => {
  if (!phone) return null;
  const digits = String(phone).replace(/[^0-9]/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  return null;
};

const toMemberPhone = (phone) => {
  const digits = normalisePhone(phone);
  if (!digits) return null;
  return digits.startsWith('254') ? '0' + digits.slice(3) : digits;
};

test('converts M-Pesa 254 format to member 07 format', () => {
  assert.equal(toMemberPhone('254712345678'), '0712345678');
  assert.equal(toMemberPhone('254722112233'), '0722112233');
  assert.equal(toMemberPhone('254700000000'), '0700000000');
});

test('passes through member 07 format unchanged', () => {
  assert.equal(toMemberPhone('0712345678'), '0712345678');
  assert.equal(toMemberPhone('0722112233'), '0722112233');
});

test('handles +254 format', () => {
  assert.equal(toMemberPhone('+254712345678'), '0712345678');
});

test('handles 9-digit format without leading zero', () => {
  assert.equal(toMemberPhone('712345678'), '0712345678');
});

test('returns null for invalid phone numbers', () => {
  assert.equal(toMemberPhone(''), null);
  assert.equal(toMemberPhone(null), null);
  assert.equal(toMemberPhone(undefined), null);
  assert.equal(toMemberPhone('0712'), null); // too short
  assert.equal(toMemberPhone('abcdefghij'), null); // no digits
  assert.equal(toMemberPhone('12345'), null); // too short
});

test('handles phone numbers with spaces and dashes', () => {
  assert.equal(toMemberPhone('254 712 345 678'), '0712345678');
  assert.equal(toMemberPhone('0712-345-678'), '0712345678');
});
