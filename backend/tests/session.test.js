/**
 * Tests for the session rules that caused repeated logins.
 *
 * The bug being guarded against: any failed profile check used to delete the
 * stored token, so a server restart, a dropped connection or a slow response
 * threw a perfectly valid session away. These tests pin the rule that only a
 * rejection of the token itself ends a session.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// Mirrors sessionIsReallyOver() in AuthContext.jsx. Duplicated rather than
// imported because that file is JSX and cannot be required by node:test.
const sessionIsReallyOver = (error) => {
  const status = error?.response?.status;
  return status === 401 || status === 403;
};

const netError = (message) => ({ message, response: undefined, isAxiosError: true });
const httpError = (status) => ({ response: { status } });

test('a rejected token ends the session', () => {
  assert.equal(sessionIsReallyOver(httpError(401)), true);
  assert.equal(sessionIsReallyOver(httpError(403)), true);
});

test('a server error does not end the session', () => {
  // The server being briefly unavailable is the case that caused the complaint.
  assert.equal(sessionIsReallyOver(httpError(500)), false);
  assert.equal(sessionIsReallyOver(httpError(502)), false);
  assert.equal(sessionIsReallyOver(httpError(503)), false);
});

test('a rate limit does not end the session', () => {
  // Being throttled is not a reason to delete a valid token.
  assert.equal(sessionIsReallyOver(httpError(429)), false);
});

test('an unreachable server does not end the session', () => {
  // No response at all: the backend is restarting or the network dropped.
  assert.equal(sessionIsReallyOver(netError('ECONNREFUSED')), false);
  assert.equal(sessionIsReallyOver(netError('Network Error')), false);
  assert.equal(sessionIsReallyOver(netError('timeout of 0ms exceeded')), false);
});

test('a timeout does not end the session', () => {
  assert.equal(sessionIsReallyOver(httpError(408)), false);
});

test('a missing error object does not end the session', () => {
  assert.equal(sessionIsReallyOver(undefined), false);
  assert.equal(sessionIsReallyOver({}), false);
});

test('a 404 on the profile route does not end the session', () => {
  // A misconfigured route is a deployment fault, not the user being signed out.
  assert.equal(sessionIsReallyOver(httpError(404)), false);
});