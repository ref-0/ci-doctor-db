import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY, publish, unpublished } from '../publish.ts';
import { partialOf } from '../reread.ts';

const SCRATCH = process.env.LOOP_TEST_DIR ?? join(homedir(), '.cache', 'ci-loop-measure');
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...IDENTITY, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir: string, path: string, body: string) => (mkdirSync(join(dir, path, '..'), { recursive: true }), writeFileSync(join(dir, path), body));

// A bare origin whose main has one report, and a clone of it on main.
function repos() {
  mkdirSync(SCRATCH, { recursive: true });
  const top = mkdtempSync(join(SCRATCH, 'publish-test-'));
  const origin = join(top, 'origin.git');
  const root = join(top, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, root], { stdio: 'ignore' });
  git(root, 'checkout', '-q', '-b', 'main');
  write(root, 'reports/a__old/2026-11-12.json', '{"old":1}');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'first');
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return { origin, root, scratch: join(top, 'scratch'), done: () => rmSync(top, { recursive: true, force: true }) };
}

const onOrigin = (origin: string) => git(origin, 'ls-tree', '-r', '--name-only', 'main').split('\n');

test("publish pushes only reports, never the checkout's own unpushed commits", () => {
  const { origin, root, scratch, done } = repos();
  write(root, 'loop/code.ts', 'unreviewed');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'a code change not yet through a PR');
  write(root, 'reports/b__new/2026-11-20.json', '{"new":1}');
  write(root, 'reports/c__stranded/2026-11-19.json', '{"stranded":1}');

  assert.deepEqual(unpublished(root), ['reports/b__new/2026-11-20.json', 'reports/c__stranded/2026-11-19.json']);
  const line = publish({ root, scratch, date: '2026-11-20', push: true, log: () => {} });

  assert.match(line, /2 reports pushed to main/);
  assert.match(line, /commits of its own/);
  assert.deepEqual(onOrigin(origin), ['reports/a__old/2026-11-12.json', 'reports/b__new/2026-11-20.json', 'reports/c__stranded/2026-11-19.json']);
  assert.equal(git(origin, 'log', '-1', '--format=%an', 'main'), 'mihar-22');
  assert.deepEqual(unpublished(root), []);
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1);
  done();
});

test("publish fast-forwards a checkout's main that has nothing of its own", () => {
  const { root, scratch, done } = repos();
  write(root, 'reports/b__new/2026-11-20.json', '{"new":1}');

  const line = publish({ root, scratch, date: '2026-11-20', push: true, log: () => {} });

  assert.match(line, /the checkout is fast-forwarded/);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.ok(existsSync(join(root, 'reports/b__new/2026-11-20.json')));
  done();
});

test('a report changed in place since origin/main had it is pushed too, and the checkout is fast-forwarded', () => {
  const { origin, root, scratch, done } = repos();
  write(root, 'reports/a__old/2026-11-12.json', '{"old":1,"practicesDate":"2026-11-29"}');
  write(root, 'reports/b__new/2026-11-20.json', '{"new":1}');

  assert.deepEqual(unpublished(root), ['reports/a__old/2026-11-12.json', 'reports/b__new/2026-11-20.json']);
  assert.match(publish({ root, scratch, date: '2026-11-29', push: false, log: () => {} }), /2 reports not on origin\/main yet \(1 changed since origin\/main had them\); not pushed/);
  const line = publish({ root, scratch, date: '2026-11-29', push: true, log: () => {} });

  assert.match(line, /2 reports pushed to main as \w+ \(1 changed since origin\/main had them\); the checkout is fast-forwarded/);
  assert.equal(git(origin, 'show', 'main:reports/a__old/2026-11-12.json'), '{"old":1,"practicesDate":"2026-11-29"}');
  assert.match(git(origin, 'log', '-1', '--format=%s', 'main'), /^Reports: 1 checks and 1 changed in place, published 2026-11-29$/);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.deepEqual(unpublished(root), []);
  done();
});

test("a report main changed since this checkout's HEAD is never overwritten by the checkout's older copy", () => {
  const { origin, root, scratch, done } = repos();
  const other = join(root, '..', 'other');
  execFileSync('git', ['clone', '-q', origin, other], { stdio: 'ignore' });
  write(other, 'reports/a__old/2026-11-12.json', '{"old":1,"practicesDate":"2026-11-30"}');
  git(other, 'commit', '-q', '-am', 'main reads it again');
  git(other, 'push', '-q', 'origin', 'main');

  // Unchanged here: main's newer copy is the pull's to bring, and nothing is pushed.
  assert.deepEqual(unpublished(root), []);
  assert.equal(publish({ root, scratch, date: '2026-11-30', push: true, log: () => {} }), 'publish: every report is on origin/main');
  assert.equal(git(origin, 'show', 'main:reports/a__old/2026-11-12.json'), '{"old":1,"practicesDate":"2026-11-30"}');

  // Changed both here and on main: left as it is, and named.
  write(root, 'reports/a__old/2026-11-12.json', '{"old":1,"practicesDate":"2026-11-29"}');
  const line = publish({ root, scratch, date: '2026-11-30', push: true, log: () => {} });
  assert.equal(line, 'publish: nothing pushed; 1 changed both here and on origin/main since HEAD, left as they are: reports/a__old/2026-11-12.json');
  assert.equal(git(origin, 'show', 'main:reports/a__old/2026-11-12.json'), '{"old":1,"practicesDate":"2026-11-30"}');
  assert.equal(git(root, 'show', ':reports/a__old/2026-11-12.json'), '{"old":1}');
  assert.equal(execFileSync('cat', [join(root, 'reports/a__old/2026-11-12.json')], { encoding: 'utf8' }), '{"old":1,"practicesDate":"2026-11-29"}');
  done();
});

test("a re-read's partial file, left by a kill, is never published", () => {
  const { root, done } = repos();
  writeFileSync(partialOf(join(root, 'reports/a__old/2026-11-12.json')), '{"old":');

  assert.deepEqual(unpublished(root), []);
  done();
});

test('without --push, or with nothing new, publish pushes nothing', () => {
  const { origin, root, scratch, done } = repos();
  assert.equal(publish({ root, scratch, date: '2026-11-20', push: true, log: () => {} }), 'publish: every report is on origin/main');

  write(root, 'reports/b__new/2026-11-20.json', '{"new":1}');
  assert.match(publish({ root, scratch, date: '2026-11-20', push: false, log: () => {} }), /1 reports not on origin\/main yet; not pushed/);
  assert.deepEqual(onOrigin(origin), ['reports/a__old/2026-11-12.json']);
  done();
});

test('a push that fails leaves the reports for the next run, and no worktree behind', () => {
  const { origin, root, scratch, done } = repos();
  write(root, 'reports/b__new/2026-11-20.json', '{"new":1}');
  writeFileSync(join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  const line = publish({ root, scratch, date: '2026-11-20', push: true, log: () => {} });

  assert.match(line, /1 reports not pushed .*the next run tries again/);
  assert.deepEqual(unpublished(root), ['reports/b__new/2026-11-20.json']);
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1);
  done();
});
