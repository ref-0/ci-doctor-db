import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { takeLock } from '../lock.ts';

const SCRATCH = process.env.LOOP_TEST_DIR ?? join(homedir(), '.cache', 'ci-loop-measure');
const dir = () => (mkdirSync(SCRATCH, { recursive: true }), mkdtempSync(join(SCRATCH, 'lock-')));

test('a second taker is told who holds the lock; released, it can be taken again', () => {
  const d = dir();
  const path = join(d, 'measure.lock');

  const first = takeLock(path);
  assert.ok('release' in first);
  assert.deepEqual(takeLock(path), { heldBy: process.pid });
  first.release();
  assert.ok(!existsSync(path));
  assert.ok('release' in takeLock(path));
  rmSync(d, { recursive: true, force: true });
});

test("a lock whose pid is gone is stale and taken over", () => {
  const d = dir();
  const path = join(d, 'measure.lock');
  const gone = spawnSync('node', ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path, `${gone}\n`);

  assert.ok('release' in takeLock(path));
  rmSync(d, { recursive: true, force: true });
});

test('a measure run started while another holds the lock exits at once, saying so', () => {
  const d = dir();
  const path = join(d, 'measure.lock');
  writeFileSync(path, `${process.pid}\n`);

  const r = spawnSync('node', [join(import.meta.dirname, '..', 'measure.ts'), '--dry-run'], { encoding: 'utf8', env: { ...process.env, LOOP_LOCK: path }, timeout: 30_000 });

  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`another measure run \\(pid ${process.pid}\\) holds the lock`));
  assert.doesNotMatch(r.stdout, /scorer:/);
  rmSync(d, { recursive: true, force: true });
});
