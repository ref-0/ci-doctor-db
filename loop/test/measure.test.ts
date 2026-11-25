import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { open } from '../db.ts';
import { importOne, importReports, refreshRepos } from '../import.ts';
import { KEEP, CHECK_MEDIAN, CHECK_P90, RUN_HOURS, runSlots, runStop, runWeek, waitForQuota, type ChangedSince, type CheckResult, type Clock } from '../measure.ts';
import { dueRefreshes } from '../queue.ts';
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
// Every repo has a new pull-request run; the queues here are gap repos, which aren't asked anyway.
const changed: ChangedSince = () => ({ changed: true, calls: 1 });

test('a run stops its length after its start, whatever the date then; its slots are what the quota allows that long', () => {
  const sunday = Date.parse('2026-11-29T22:00:00Z');

  assert.equal(runStop(sunday, 11), Date.parse('2026-11-30T09:00:00Z'));
  assert.equal(runStop(sunday, 0.5), sunday + 1_800_000);
  assert.throws(() => runStop(sunday, 0), /--hours takes a number of hours above 0/);
  assert.throws(() => runStop(sunday, Number('eleven')), /--hours/);
  assert.equal(runSlots(5000, RUN_HOURS), Math.floor(((5000 - KEEP) * RUN_HOURS) / CHECK_MEDIAN));
  assert.equal(runSlots(500, RUN_HOURS), 0);
});

test('a check never runs past the stop time: its timeout is what is left, up to 10 minutes', async () => {
  const { db, reportsDir, done } = setup();
  const clock = fakeClock(STOP - 3 * 60_000);
  const timeouts: number[] = [];

  await runWeek(entries('a/1', 'a/2'), {
    db, reportsDir, clock, stopAt: STOP, quota: fakeQuota(clock).read, token: () => 't',
    check: async (repo, _t, timeoutMs) => (timeouts.push(timeoutMs), await clock.sleep(60_000), { report: report(repo) }),
    importOne, refreshRepos, changedSince: changed, log: () => {},
  });

  assert.deepEqual(timeouts, [180_000, 120_000]);
  const early = fakeClock();
  const t: number[] = [];
  await runWeek(entries('a/3'), { db, reportsDir, clock: early, stopAt: STOP, quota: fakeQuota(early).read, token: () => 't', check: async (repo, _t, ms) => (t.push(ms), { report: report(repo) }), importOne, refreshRepos, changedSince: changed, log: () => {} });
  assert.deepEqual(t, [600_000]);
  done();
});

test('a run given no length to measure for stops before it touches the scorer', () => {
  mkdirSync(SCRATCH, { recursive: true });
  const r = spawnSync('node', [join(import.meta.dirname, '..', 'measure.ts'), '--hours', '0'], {
    encoding: 'utf8',
    env: { ...process.env, LOOP_LOCK: join(SCRATCH, `stop-test-${process.pid}.lock`) },
    timeout: 30_000,
  });

  assert.equal(r.status, 1);
  assert.match(r.stderr, /the run couldn't start: --hours takes a number of hours above 0, not 0/);
  assert.doesNotMatch(r.stdout, /scorer:/);
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

test('a reset time already past pauses a minute at a time, and ends the run after 4 pauses', async () => {
  const clock = fakeClock();
  const stuck = () => ({ remaining: 10, limit: 5000, reset: Math.floor((T0 - 3_600_000) / 1000) });
  let reads = 0;

  const r = await waitForQuota(clock, () => (reads++, stuck()), STOP, () => {});

  assert.deepEqual(r, { go: false, why: 'quota 10 stayed low after 4 pauses' });
  assert.deepEqual(clock.slept, [60_000, 60_000, 60_000, 60_000]);
  assert.equal(reads, 5);
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

test('a run stores each report and its check, records failures with their reason, and goes on', async () => {
  const { db, reportsDir, done } = setup();
  const clock = fakeClock();
  const q = fakeQuota(clock);
  const results: Record<string, CheckResult> = {
    'a/one': { report: report('a/one') },
    'a/broken': { error: 'GitHub answered 502 for repos/a/broken/actions/runs' },
    'a/quiet': { report: report('a/quiet', { score: null, grade: null, band: null, unscored: 'Only 2 PR pushes in the window.' }) },
  };

  const run = await runWeek(entries('a/one', 'a/broken', 'a/quiet'), {
    db, reportsDir, clock, stopAt: STOP, quota: q.read, token: () => 'test-token',
    check: async (repo, token) => (assert.equal(token, 'test-token'), q.spend(repo === 'a/broken' ? 12 : 66), clock.sleep(60_000), results[repo]!),
    importOne, refreshRepos, changedSince: changed, log: () => {},
  });

  assert.equal(run.stopped, 'the queue is done');
  assert.deepEqual(run.outcomes.map((o) => [o.repo, o.outcome, o.calls]), [['a/one', 'scored', 66], ['a/broken', 'failed', 12], ['a/quiet', 'unscored', 66]]);
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

test("a repo with today's report already stored isn't measured, and the log says so", async () => {
  const { db, reportsDir, done } = setup();
  const clock = fakeClock();
  const today = new Date(T0).toISOString().slice(0, 10);
  mkdirSync(join(reportsDir, 'pip__garden'), { recursive: true });
  writeFileSync(join(reportsDir, 'pip__garden', `${today}.json`), '{}');
  const checked: string[] = [];
  const lines: string[] = [];

  const run = await runWeek(entries('pip/garden', 'mo/shed', 'a/merged'), {
    db, reportsDir, clock, stopAt: STOP, quota: fakeQuota(clock).read, token: () => 't',
    check: async (repo) => (checked.push(repo), { report: report(repo) }),
    importOne, refreshRepos, changedSince: changed, log: (s) => lines.push(s),
    // On origin/main though not in this checkout yet, as a submission merged today is.
    stored: (file) => existsSync(join(reportsDir, file)) || file === `a__merged/${today}.json`,
  });

  assert.deepEqual(checked, ['mo/shed']);
  assert.deepEqual(run.present, ['pip/garden', 'a/merged']);
  assert.ok(lines.some((l) => l.endsWith(`gap pip/garden: skipped, reports/pip__garden/${today}.json is already there`)));
  assert.equal(readFileSync(join(reportsDir, 'pip__garden', `${today}.json`), 'utf8'), '{}');
  done();
});

test('a run pauses for the quota mid-queue, then stops at its stop time with the rest unchecked', async () => {
  const { db, reportsDir, done } = setup();
  const clock = fakeClock();
  // Room for 2 checks before the quota is low; each check takes 10 minutes.
  const q = fakeQuota(clock, { start: KEEP + CHECK_P90 + 2 * 66 - 1 });
  const logs: string[] = [];
  const queue = entries(...Array.from({ length: 30 }, (_, i) => `a/r${i}`));

  const run = await runWeek(queue, {
    db, reportsDir, clock, stopAt: STOP, quota: q.read, token: () => 't',
    check: async (repo) => (q.spend(), await clock.sleep(10 * 60_000), { report: report(repo) }),
    importOne, refreshRepos, changedSince: changed, log: (s) => logs.push(s),
  });

  // 02:00 and 02:10, then a pause until 03:00's reset and 30 seconds, then every 10 minutes from 03:00:30 to 04:50:30.
  assert.equal(logs.filter((l) => /pausing/.test(l)).length, 1);
  assert.equal(run.outcomes[2]!.at, '2026-11-20T03:00:30.000Z');
  assert.equal(run.outcomes.length, 14);
  assert.equal(run.outcomes.at(-1)!.at, '2026-11-20T04:50:30.000Z');
  assert.equal(run.stopped, 'reached the stop time');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM checks`).get()!.n, 14);
  done();
});

test('a quota still low at the stop time ends the run without checking', async () => {
  const { db, reportsDir, done } = setup();
  const clock = fakeClock(STOP - 30 * 60_000);
  const q = fakeQuota(clock, { start: KEEP });
  let checked = 0;

  const run = await runWeek(entries('a/1'), {
    db, reportsDir, clock, stopAt: STOP, quota: q.read, token: () => 't',
    check: async (repo) => (checked++, { report: report(repo) }),
    importOne, refreshRepos, changedSince: changed, log: () => {},
  });

  assert.equal(checked, 0);
  assert.match(run.stopped, /low until after the stop time/);
  done();
});

test('a token that fails ends the run, recorded as why it stopped', async () => {
  const { db, reportsDir, done } = setup();
  const clock = fakeClock();

  const run = await runWeek(entries('a/1'), {
    db, reportsDir, clock, stopAt: STOP, quota: fakeQuota(clock).read,
    token: () => { throw new Error('no key'); },
    check: async (repo) => ({ report: report(repo) }),
    importOne, refreshRepos, changedSince: changed, log: () => {},
  });

  assert.deepEqual(run.outcomes, []);
  assert.equal(run.stopped, 'token.ts failed: no key');
  done();
});

test("a quota that can't be read ends the run with its reason, keeping what was checked", async () => {
  const { db, reportsDir, done } = setup();
  const clock = fakeClock();
  const q = fakeQuota(clock);
  let reads = 0;

  const run = await runWeek(entries('a/1', 'a/2', 'a/3'), {
    db, reportsDir, clock, stopAt: STOP, token: () => 't',
    quota: () => (++reads > 1 ? (() => { throw new Error('gh api rate_limit: HTTP 502: Bad Gateway'); })() : q.read()),
    check: async (repo) => ({ report: report(repo) }),
    importOne, refreshRepos, changedSince: changed, log: () => {},
  });

  assert.deepEqual(run.outcomes.map((o) => o.repo), ['a/1']);
  assert.match(run.stopped, /the quota couldn't be read: .*502/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM repos`).get()!.n, 1);
  done();
});

test("a gap repo's GitHub id is stored with its row", async () => {
  const { db, reportsDir, done } = setup();
  const clock = fakeClock();

  await runWeek([{ repo: 'a/new', reason: 'gap', why: 'test', githubId: 4242 }], {
    db, reportsDir, clock, stopAt: STOP, quota: fakeQuota(clock).read, token: () => 't',
    check: async (repo) => ({ report: report(repo) }), importOne, refreshRepos, changedSince: changed, log: () => {},
  });

  assert.equal(db.prepare(`SELECT github_id FROM repos WHERE repo = 'a/new'`).get()!.github_id, 4242);
  done();
});

test('a run that starts on Sunday evening crosses midnight and stops by its length', async () => {
  const { db, reportsDir, done } = setup();
  const start = Date.parse('2026-11-29T20:00:00Z');
  const clock = fakeClock(start);
  const q = fakeQuota(clock);
  const queue = entries(...Array.from({ length: 40 }, (_, i) => `a/r${i}`));

  // Each check takes 30 minutes, so 22 fit in 11 hours: 20:00 to 06:30 the next day.
  const run = await runWeek(queue, {
    db, reportsDir, clock, stopAt: runStop(start, 11), quota: q.read, token: () => 't',
    check: async (repo) => (q.spend(), await clock.sleep(30 * 60_000), { report: report(repo) }),
    importOne, refreshRepos, changedSince: changed, log: () => {},
  });

  assert.equal(run.outcomes.length, 22);
  assert.equal(run.outcomes.filter((o) => o.at >= '2026-11-30').length, 14);
  assert.equal(run.outcomes.at(-1)!.at, '2026-11-30T06:30:00.000Z');
  assert.equal(run.stopped, 'reached the stop time');
  done();
});

// A repo measured once, by a gap check at `at`, so it has a latest report and a measured time to ask from.
async function measuredOnce(db: ReturnType<typeof open>, reportsDir: string, repo: string, at: number) {
  const clock = fakeClock(at);
  await runWeek(entries(repo), {
    db, reportsDir, clock, stopAt: at + 3_600_000, quota: fakeQuota(clock).read, token: () => 't',
    check: async (r) => ({ report: report(r) }), importOne, refreshRepos, changedSince: changed, log: () => {},
  });
  return db.prepare(`SELECT at FROM checks WHERE repo = ?`).get(repo)!.at as string;
}

test('a repo with no pull-request run since its last report is skipped and keeps its latest; one new run measures it; a failed read measures it', async () => {
  const { db, reportsDir, done } = setup();
  const lastWeek = Date.parse('2026-11-22T10:00:00Z');
  for (const repo of ['a/quiet', 'a/busy', 'a/unread']) await measuredOnce(db, reportsDir, repo, lastWeek);
  const latest = (repo: string) => db.prepare(`SELECT latest_report FROM repos WHERE repo = ?`).get(repo)!.latest_report;
  const before = latest('a/quiet');
  const clock = fakeClock(Date.parse('2026-11-29T10:00:00Z'));
  const asked: string[] = [];
  const checked: string[] = [];
  const lines: string[] = [];
  // a/busy has one new run; a/unread's read fails.
  const changedSince: ChangedSince = (repo, since) => {
    asked.push(`${repo} ${since}`);
    if (repo === 'a/unread') throw new Error('gh api repos/a/unread/actions/runs: HTTP 502');
    return repo === 'a/busy' ? { changed: true, calls: 1 } : { changed: false, calls: 2 };
  };
  const due = dueRefreshes(db, '2026-11-29');

  const run = await runWeek(due, {
    db, reportsDir, clock, stopAt: runStop(clock.now(), 11), quota: fakeQuota(clock).read, token: () => 't',
    check: async (repo) => (checked.push(repo), { report: report(repo, { date: '2026-11-29' }) }),
    importOne, refreshRepos, changedSince, log: (s) => lines.push(s),
  });

  assert.deepEqual(asked, ['a/busy 2026-11-22T10:00:00.000Z', 'a/quiet 2026-11-22T10:00:00.000Z', 'a/unread 2026-11-22T10:00:00.000Z']);
  assert.deepEqual(checked, ['a/busy', 'a/unread']);
  assert.deepEqual(run.unchanged, ['a/quiet']);
  assert.equal(run.askCalls, 3);
  assert.equal(latest('a/quiet'), before);
  assert.equal(latest('a/busy'), 'a/busy/2026-11-29');
  assert.ok(lines.some((l) => /a\/unread: couldn't read its runs since .*, so it's measured: .*502/.test(l)));
  assert.ok(lines.some((l) => l.endsWith('refresh a/quiet: skipped, no pull-request run since 2026-11-22T10:00:00.000Z, 2 calls')));
  const skips = db.prepare(`SELECT repo, at, since, why, calls FROM skips`).all().map((r) => ({ ...r }));
  assert.deepEqual(skips, [{ repo: 'a/quiet', at: '2026-11-29T10:00:00.000Z', since: '2026-11-22T10:00:00.000Z', why: 'no pull-request run since 2026-11-22T10:00:00.000Z', calls: 2 }]);
  done();
});

test("a skipped repo isn't a failed check or an attempt: it's due again next run, and its latest report's age shows the skips", async () => {
  const { db, reportsDir, done } = setup();
  await measuredOnce(db, reportsDir, 'a/quiet', Date.parse('2026-11-22T10:00:00Z'));
  const quiet: ChangedSince = () => ({ changed: false, calls: 2 });

  for (const sunday of ['2026-11-29', '2026-12-06']) {
    const clock = fakeClock(Date.parse(`${sunday}T10:00:00Z`));
    const due = dueRefreshes(db, sunday);
    assert.deepEqual(due.map((e) => e.repo), ['a/quiet'], `due on ${sunday}`);
    assert.match(due[0]!.why, /^last report 2026-11-\d\d, \d+ days ago/);
    await runWeek(due, {
      db, reportsDir, clock, stopAt: runStop(clock.now(), 11), quota: fakeQuota(clock).read, token: () => 't',
      check: async () => assert.fail('a skipped repo is not checked'), importOne, refreshRepos, changedSince: quiet, log: () => {},
    });
  }

  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM checks WHERE repo = 'a/quiet'`).get()!.n, 1);
  assert.equal(db.prepare(`SELECT times_checked FROM repos WHERE repo = 'a/quiet'`).get()!.times_checked, 1);
  const age = { ...db.prepare(`SELECT repo, latest_report, report_date, skips_since, last_skipped FROM latest_age`).get() };
  assert.deepEqual(age, { repo: 'a/quiet', latest_report: `a/quiet/${FIXTURE.date}`, report_date: FIXTURE.date, skips_since: 2, last_skipped: '2026-12-06T10:00:00.000Z' });
  done();
});
