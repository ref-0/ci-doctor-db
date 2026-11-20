import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTransient, withRetry } from '../github.ts';

test('a transient read is tried again with backoff, and succeeds', () => {
  const slept: number[] = [];
  let calls = 0;

  const r = withRetry(() => (++calls < 3 ? (() => { throw new Error('gh api rate_limit: HTTP 502: Bad Gateway'); })() : 'ok'), { sleep: (ms) => void slept.push(ms) });

  assert.equal(r, 'ok');
  assert.deepEqual(slept, [2000, 4000]);
});

test('a transient read that keeps failing gives up after 4 tries; any other failure at once', () => {
  let calls = 0;
  assert.throws(() => withRetry(() => { calls++; throw new Error('read: connection reset by peer'); }, { sleep: () => {} }), /connection reset/);
  assert.equal(calls, 4);

  calls = 0;
  assert.throws(() => withRetry(() => { calls++; throw new Error('gh api repos/x/y: HTTP 404: Not Found'); }, { sleep: () => {} }), /404/);
  assert.equal(calls, 1);
});

test('5xx and lost connections are transient; 4xx are not', () => {
  for (const m of ['HTTP 500', 'HTTP 503: Service Unavailable', 'Post "https://api.github.com/graphql": unexpected EOF', 'dial tcp: i/o timeout', 'ECONNRESET'])
    assert.ok(isTransient(m), m);
  for (const m of ['HTTP 404: Not Found', 'HTTP 403: API rate limit exceeded', 'HTTP 401: Bad credentials']) assert.ok(!isTransient(m), m);
});
