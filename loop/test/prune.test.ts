import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prune } from '../prune.ts';

const SCRATCH = process.env.LOOP_TEST_DIR ?? join(homedir(), '.cache', 'ci-loop-measure');
const NOW = Date.parse('2026-11-19T12:00:00Z');
const OLD = (NOW - 20 * 86_400_000) / 1000;

// A checkout-like folder with cache/ and reports/, each holding old files.
function checkout() {
  mkdirSync(SCRATCH, { recursive: true });
  const root = mkdtempSync(join(SCRATCH, 'prune-'));
  const file = (p: string, body: string, mtime = OLD) => (writeFileSync(join(root, p), body), utimesSync(join(root, p), mtime, mtime));
  mkdirSync(join(root, 'cache', 'logs'), { recursive: true });
  mkdirSync(join(root, 'reports', 'a__b'), { recursive: true });
  file('cache/old', 'x'.repeat(100));
  file('cache/logs/old.log', 'y'.repeat(50));
  file('cache/new', 'z', NOW / 1000);
  file('reports/a__b/2026-10-01.json', '{}');
  return { root, cache: join(root, 'cache'), done: () => rmSync(root, { recursive: true, force: true }) };
}

test('prune deletes cache files older than 14 days, and only lists them on a dry run', () => {
  const { root, cache, done } = checkout();

  const dry = prune(cache, { root: cache, now: NOW, dryRun: true });
  assert.deepEqual({ files: dry.files, bytes: dry.bytes, kept: dry.kept }, { files: 2, bytes: 150, kept: 1 });
  assert.ok(existsSync(join(cache, 'old')));

  prune(cache, { root: cache, now: NOW, dryRun: false });
  assert.ok(!existsSync(join(cache, 'old')));
  assert.ok(!existsSync(join(cache, 'logs')));
  assert.ok(existsSync(join(cache, 'new')));
  assert.ok(existsSync(join(root, 'reports', 'a__b', '2026-10-01.json')));
  done();
});

test('prune refuses a folder outside cache/, such as reports/', () => {
  const { root, cache, done } = checkout();

  assert.throws(() => prune(join(root, 'reports'), { root: cache, now: NOW, dryRun: false }), /refusing to prune/);
  assert.throws(() => prune(join(cache, '..', 'reports'), { root: cache, now: NOW, dryRun: false }), /refusing to prune/);
  assert.ok(existsSync(join(root, 'reports', 'a__b', '2026-10-01.json')));
  done();
});

test('prune refuses a cache/ that is a symlink, and leaves symlinks inside cache/ alone', () => {
  const { root, cache, done } = checkout();
  const linked = join(root, 'linked-cache');
  symlinkSync(join(root, 'reports'), linked);
  assert.throws(() => prune(linked, { root: linked, now: NOW, dryRun: false }), /not a folder/);

  symlinkSync(join(root, 'reports'), join(cache, 'to-reports'));
  prune(cache, { root: cache, now: NOW, dryRun: false });
  assert.ok(existsSync(join(cache, 'to-reports')));
  assert.ok(existsSync(join(root, 'reports', 'a__b', '2026-10-01.json')));
  done();
});

test('prune rejects days that are not a positive number', () => {
  const { cache, done } = checkout();

  for (const days of [NaN, 0, -3, Infinity]) assert.throws(() => prune(cache, { root: cache, days, now: NOW, dryRun: false }), /positive number/);
  assert.ok(existsSync(join(cache, 'old')));
  done();
});
