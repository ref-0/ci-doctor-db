import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { childEnv, debugSettings } from '../env.ts';

test("children get no NODE_DEBUG and no debug flags in NODE_OPTIONS, and keep the rest", () => {
  const env = childEnv({ GH_TOKEN: 't' }, { PATH: '/bin', NODE_DEBUG: 'child_process', NODE_DEBUG_NATIVE: 'x', NODE_OPTIONS: '--max-old-space-size=4096 --inspect=0 --inspect-brk' });

  assert.deepEqual(env, { PATH: '/bin', NODE_OPTIONS: '--max-old-space-size=4096', GH_TOKEN: 't' });
  assert.equal(childEnv({}, { NODE_OPTIONS: '--inspect-brk' }).NODE_OPTIONS, undefined);
});

test('debug settings are named', () => {
  assert.deepEqual(debugSettings({ NODE_DEBUG: 'child_process', NODE_OPTIONS: '--inspect' }), ['NODE_DEBUG is set', 'NODE_OPTIONS has --inspect']);
  assert.deepEqual(debugSettings({ NODE_OPTIONS: '--max-old-space-size=4096' }), []);
});

test('the measure job refuses to start with NODE_DEBUG set, before it spawns anything', () => {
  const r = spawnSync('node', [join(import.meta.dirname, '..', 'measure.ts'), '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_DEBUG: 'child_process', HOME: '/nonexistent' },
  });

  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to run with Node's debugging on/);
  assert.doesNotMatch(r.stderr, /CHILD_PROCESS|spawn/);
});
