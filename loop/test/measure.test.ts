import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { open } from '../db.ts';
import { importOne, importReports, refreshRepos } from '../import.ts';
import { KEEP, CHECK_P90, nextAt, runNight, waitForQuota, type CheckResult, type Clock } from '../measure.ts';
import { prune } from '../prune.ts';
import type { Quota } from '../github.ts';
import type { Entry } from '../queue.ts';

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'vitejs__vite', '2026-11-19.json'), 'utf8'));
const SCRATCH = process.env.LOOP_TEST_DIR ?? join(homedir(), '.cache', 'ci-loop-measure');
const T0 = Date.parse('2026-11-20T02:00:00Z');
const STOP = Date.parse('2026-11-20T05:00:00Z');

function fakeClock(start = T0): Clock & { slept: number[] } {
  let t = start;
  const slept: number[] = [];
  return { slept, now: () => t, sleep: async (ms) => void (slept.push(ms), (t += ms)) };
}

// A quota that each check spends `perCheck` of, resetting to `limit` on the hour.
function fakeQuota(clock: Clock, { limit = 5000, start = limit, perCheck = 66 } = {}) {
  let remaining = start;
  let reset = Math.floor((clock.now() + 3_600_000) / 1000);
  return {
    read: (): Quota => {
      if (clock.now() >= reset * 1000) (remaining = limit), (reset += 3600);
      return { remaining, limit, reset };
    },
    spend: (n = perCheck) => void (remaining -= n),
  };
}

function setup() {
  mkdirSync(SCRATCH, { recursive: true });
  const reportsDir = mkdtempSync(join(SCRATCH, 'reports-'));
  return { db: open(':memory:'), reportsDir, done: () => rmSync(reportsDir, { recursive: true, force: true }) };
}

const entries = (...repos: string[]): Entry[] => repos.map((repo) => ({ repo, reason: 'gap', why: 'test' }));
const report = (repo: string, extra: Record<string, unknown> = {}) => ({ ...FIXTURE, repo, read: { calls: 66 }, ...extra });

test('the stop time is the next 05:00 after the start', () => {
  const start = new Date(2026, 10, 20, 2, 0).getTime();
  assert.equal(nextAt(start, '05:00'), new Date(2026, 10, 20, 5, 0).getTime());
  assert.equal(nextAt(new Date(2026, 10, 19, 17, 0).getTime(), '05:00'), new Date(2026, 10, 20, 5, 0).getTime());
});

test('a low quota pauses until its reset, then goes on', async () => {
  const clock = fakeClock();
  const q = fakeQuota(clock, { start: KEEP + CHECK_P90 - 1 });
  const logs: string[] = [];

  const r = await waitForQuota(clock, q.read, STOP, (s) => logs.push(s));

  assert.equal(r.go, true);
  assert.equal(clock.slept.length, 1);
  assert.equal(clock.now(), T0 + 3_600_000 + 30_000);
  assert.match(logs[0]!, /pausing 3630 seconds until the reset/);
});

test('it stops at the stop time, and when the quota resets only after it', async () => {
  const late = fakeClock(STOP);
  assert.deepEqual(await waitForQuota(late, fakeQuota(late).read, STOP, () => {}), { go: false, why: 'reached the stop time' });

  const clock = fakeClock(STOP - 600_000);
  const low = fakeQuota(clock, { start: 500 });
  const r = await waitForQuota(clock, low.read, STOP, () => {});
  assert.equal(r.go, false);
  assert.match((r as { why: string }).why, /low until after the stop time/);
  assert.equal(clock.slept.length, 0);
});

test('a night stores each report and its check, records failures with their reason, and goes on', async () => {
  const { db, reportsDir, done } = setup();
  const clock = fakeClock();
  const q = fakeQuota(clock);
  const results: Record<string, CheckResult> = {
    'a/one': { report: report('a/one') },
    'a/broken': { error: 'GitHub answered 502 for repos/a/broken/actions/runs' },
    'a/quiet': { report: report('a/quiet', { score: null, grade: null, band: null, unscored: 'Only 2 PR pushes in the window.' }) },
  };

  const night = await runNight(entries('a/one', 'a/broken', 'a/quiet'), {
    db, reportsDir, clock, stopAt: STOP, quota: q.read, token: () => 'test-token',
    check: async (repo, token) => (assert.equal(token, 'test-token'), q.spend(repo === 'a/broken' ? 12 : 66), clock.sleep(60_000), results[repo]!),
    importOne, refreshRepos, log: () => {},
  });

  assert.equal(night.stopped, 'the queue is done');
  assert.deepEqual(night.outcomes.map((o) => [o.repo, o.outcome, o.calls]), [['a/one', 'scored', 66], ['a/broken', 'failed', 12], ['a/quiet', 'unscored', 66]]);
  assert.ok(existsSync(join(reportsDir, 'a__one', `${FIXTURE.date}.json`)));

  const checks = db.prepare(`SELECT repo, reason, scored, report, error, calls FROM checks ORDER BY at`).all().map((c) => ({ ...c }));
  assert.deepEqual(checks, [
    { repo: 'a/one', reason: 'gap', scored: 1, report: `a/one/${FIXTURE.date}`, error: null, calls: 66 },
    { repo: 'a/broken', reason: 'gap', scored: 0, report: null, error: 'GitHub answered 502 for repos/a/broken/actions/runs', calls: 12 },
    { repo: 'a/quiet', reason: 'gap', scored: 0, report: `a/quiet/${FIXTURE.date}`, error: 'Only 2 PR pushes in the window.', calls: 66 },
  ]);
  const repos = db.prepare(`SELECT repo, times_checked, latest_report FROM repos ORDER BY repo`).all().map((r) => ({ ...r }));
  assert.deepEqual(repos, [
    { repo: 'a/broken', times_checked: 1, latest_report: null },
    { repo: 'a/one', times_checked: 1, latest_report: `a/one/${FIXTURE.date}` },
    { repo: 'a/quiet', times_checked: 1, latest_report: `a/quiet/${FIXTURE.date}` },
  ]);

  // A later import of the same reports adds no import checks for them.
  importReports(db, reportsDir);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM checks`).get()!.n, 3);
  done();
});

test('a night pauses for the quota mid-queue, then stops at 05:00 with the rest unchecked', async () => {
  const { db, reportsDir, done } = setup();
  const clock = fakeClock();
  // Room for 2 checks before the quota is low; each check takes 10 minutes.
  const q = fakeQuota(clock, { start: KEEP + CHECK_P90 + 2 * 66 - 1 });
  const logs: string[] = [];
  const queue = entries(...Array.from({ length: 30 }, (_, i) => `a/r${i}`));

  const night = await runNight(queue, {
    db, reportsDir, clock, stopAt: STOP, quota: q.read, token: () => 't',
    check: async (repo) => (q.spend(), await clock.sleep(10 * 60_000), { report: report(repo) }),
    importOne, refreshRepos, log: (s) => logs.push(s),
  });

  // 02:00 and 02:10, then a pause until 03:00's reset and 30 seconds, then every 10 minutes from 03:00:30 to 04:50:30.
  assert.equal(logs.filter((l) => /pausing/.test(l)).length, 1);
  assert.equal(night.outcomes[2]!.at, '2026-11-20T03:00:30.000Z');
  assert.equal(night.outcomes.length, 14);
  assert.equal(night.outcomes.at(-1)!.at, '2026-11-20T04:50:30.000Z');
  assert.equal(night.stopped, 'reached the stop time');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM checks`).get()!.n, 14);
  done();
});

test('a quota still low at the stop time ends the night without checking', async () => {
  const { db, reportsDir, done } = setup();
  const clock = fakeClock(STOP - 30 * 60_000);
  const q = fakeQuota(clock, { start: KEEP });
  let checked = 0;

  const night = await runNight(entries('a/1'), {
    db, reportsDir, clock, stopAt: STOP, quota: q.read, token: () => 't',
    check: async (repo) => (checked++, { report: report(repo) }),
    importOne, refreshRepos, log: () => {},
  });

  assert.equal(checked, 0);
  assert.match(night.stopped, /low until after the stop time/);
  done();
});

test('a token that fails ends the night, recorded as why it stopped', async () => {
  const { db, reportsDir, done } = setup();
  const clock = fakeClock();

  const night = await runNight(entries('a/1'), {
    db, reportsDir, clock, stopAt: STOP, quota: fakeQuota(clock).read,
    token: () => { throw new Error('no key'); },
    check: async (repo) => ({ report: report(repo) }),
    importOne, refreshRepos, log: () => {},
  });

  assert.deepEqual(night.outcomes, []);
  assert.equal(night.stopped, 'token.ts failed: no key');
  done();
});

test('prune deletes cache files older than 14 days, and only lists them on a dry run', () => {
  mkdirSync(SCRATCH, { recursive: true });
  const cache = mkdtempSync(join(SCRATCH, 'cache-'));
  const now = Date.parse('2026-11-19T12:00:00Z');
  const old = (now - 20 * 86_400_000) / 1000;
  mkdirSync(join(cache, 'logs'));
  writeFileSync(join(cache, 'old'), 'x'.repeat(100));
  writeFileSync(join(cache, 'logs', 'old.log'), 'y'.repeat(50));
  writeFileSync(join(cache, 'new'), 'z');
  utimesSync(join(cache, 'old'), old, old);
  utimesSync(join(cache, 'logs', 'old.log'), old, old);
  utimesSync(join(cache, 'new'), now / 1000, now / 1000);

  const dry = prune(cache, { now, dryRun: true });
  assert.deepEqual({ files: dry.files, bytes: dry.bytes, kept: dry.kept }, { files: 2, bytes: 150, kept: 1 });
  assert.ok(existsSync(join(cache, 'old')));

  prune(cache, { now, dryRun: false });
  assert.ok(!existsSync(join(cache, 'old')));
  assert.ok(!existsSync(join(cache, 'logs')));
  assert.ok(existsSync(join(cache, 'new')));
  rmSync(cache, { recursive: true, force: true });
});
