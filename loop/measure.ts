// The weekly measure run: find, measure, read practices again, store, publish. The scheduled job on Sunday at 02:00
// runs this and nothing else. After the checks, while its hours and the quota last, it reads again the practices of each
// latest report the scorer's practice detection has changed since (reread.ts), the repos it skipped included.
// It prints one summary line per stage, writes the detail to logs/measure-<date>.log, and exits non-zero only when the
// run couldn't start at all: no scorer checkout, no database or no token.
// Usage: node loop/measure.ts [--max <n>] [--hours <h>] [--dry-run] [--push] [--prune]
//   --hours     how long the run measures, from its start (default RUN_HOURS, 11); it may cross midnight
//   --max       the most repos it queues (default: what the quota allows in --hours)
//   --dry-run   prints the queue with each repo's reason, and how many reports' practices are due, and checks nothing
//   --push      pushes every report origin/main lacks, or holds as HEAD does while it changed here, to main, as one
//               data commit made on origin/main (publish.ts)
//   --prune     really deletes the cache's old files; without it the prune stage only says what it would delete
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { childEnv, debugSettings } from './env.ts';
import type { Quota } from './github.ts';
import { runLock, takeLock } from './lock.ts';
import { publish, publishedReports } from './publish.ts';
import type { Entry } from './queue.ts';

const ROOT = join(import.meta.dirname, '..');
export const SCORER_CHECKOUT = join(homedir(), 'ref0-work', 'ci-doctor-next');
const SCORER_REMOTE = 'https://github.com/ref-0/ci-doctor.git';
const SCRATCH = join(homedir(), '.cache', 'ci-loop-measure');

// The App's hourly limit is shared with the site once it's live: keep 1,000 spare, and room for a p90 check.
export const KEEP = 1_000;
export const CHECK_MEDIAN = 66;
export const CHECK_P90 = 103;
export const RESET_SLACK_MS = 30_000;
export const CHECK_TIMEOUT_MS = 600_000;

// How long a run measures by default, so one run a week covers every tracked repo. The App's 5,000 calls an hour less
// KEEP and a p90 check's room leave about 3,900 an hour, 59 checks at the median 66; a check also takes about a minute
// end to end, so it's about 60 checks an hour either way, and 11 hours is about 650 checks: every tracked repo, with
// room for the week's gaps. From Sunday's 02:00 it stops by 13:00, an hour before the learn job reads loop.db.
export const RUN_HOURS = 11;

// The run's slots: what the hourly limit less KEEP allows for `hours`, at a median check.
export const runSlots = (limit: number, hours: number) => Math.floor((Math.max(0, limit - KEEP) * hours) / CHECK_MEDIAN);

// When a run that starts at `start` stops: `hours` later, whatever the date then.
export function runStop(start: number, hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) throw new Error(`--hours takes a number of hours above 0, not ${hours}`);
  return start + hours * 3_600_000;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

// Before each check: stop at the deadline, or wait for the quota's reset while it's low, as batch.sh does. A pause
// is at least a minute, so a reset time already past can't spin on the quota endpoint, and after MAX_PAUSES pauses
// in a row the run ends.
export const MIN_PAUSE_MS = 60_000;
export const MAX_PAUSES = 4;

export async function waitForQuota(clock: Clock, quota: () => Quota, stopAt: number, log: (s: string) => void) {
  for (let pauses = 0; ; pauses++) {
    if (clock.now() >= stopAt) return { go: false as const, why: 'reached the stop time' };
    const q = quota();
    if (q.remaining >= KEEP + CHECK_P90) return { go: true as const, quota: q };
    if (pauses >= MAX_PAUSES) return { go: false as const, why: `quota ${q.remaining} stayed low after ${MAX_PAUSES} pauses` };
    const until = Math.max(q.reset * 1000 + RESET_SLACK_MS, clock.now() + MIN_PAUSE_MS);
    if (until >= stopAt) return { go: false as const, why: `quota ${q.remaining} is low until after the stop time` };
    log(`${new Date(clock.now()).toISOString()} quota ${q.remaining} < ${KEEP + CHECK_P90}, pausing ${Math.round((until - clock.now()) / 1000)} seconds until the reset`);
    await clock.sleep(until - clock.now());
  }
}

export type CheckResult = { report: Record<string, any> } | { error: string };

// A report as its file holds it: what the run writes for a check, and a re-read writes back in place.
export const reportText = (report: Record<string, unknown>) => JSON.stringify(report, null, 1);

// What a skip asks before a full check: whether a pull-request run was created since `since`, and the calls it spent.
export type ChangedSince = (repo: string, since: string, token: string) => { changed: boolean; calls: number } | Promise<{ changed: boolean; calls: number }>;

export interface RunDeps {
  db: DatabaseSync;
  reportsDir: string;
  clock: Clock;
  stopAt: number;
  quota: () => Quota;
  token: () => string;
  check: (repo: string, token: string, timeoutMs: number) => Promise<CheckResult>;
  changedSince: ChangedSince;
  importOne: (db: DatabaseSync, reportsDir: string, dir: string, file: string) => { id: string };
  refreshRepos: (db: DatabaseSync) => number;
  log: (s: string) => void;
  /** Whether `<owner>__<repo>/<date>.json` is stored already. Default: under reportsDir. */
  stored?: (file: string) => boolean;
  /** Called for each report a check stored, with the check's time: the run's practice detection read its practices. */
  readBy?: (report: string, at: string) => void;
}

export type Outcome = { repo: string; reason: Entry['reason']; at: string; outcome: 'scored' | 'unscored' | 'failed'; calls: number | null; error: string | null; file: string | null };

// Checks the queue in order until it's done or the stop time. Every check is recorded, failures with their reason.
// A repo with a report for today stored already, such as one submitted, isn't measured: the run never writes over a
// report, as a submission never replaces one. A repo measured before is asked first whether a pull-request run was
// created since; with none, the score has nothing new to read, so it isn't measured: it keeps its latest report, the
// skip goes in `skips` (not in `checks`, so it's neither a failure nor an attempt), and it's due again next run. A read
// that fails measures the repo.
export async function runWeek(queue: Entry[], d: RunDeps) {
  const outcomes: Outcome[] = [];
  const present: string[] = [];
  const unchanged: string[] = [];
  let askCalls = 0;
  let stopped = 'the queue is done';
  const stored = d.stored ?? ((file: string) => existsSync(join(d.reportsDir, file)));

  for (const e of queue) {
    const file = `${e.repo.replace('/', '__')}/${new Date(d.clock.now()).toISOString().slice(0, 10)}.json`;
    if (stored(file)) {
      present.push(e.repo);
      d.log(`${new Date(d.clock.now()).toISOString()} ${e.reason} ${e.repo}: skipped, reports/${file} is already there`);
      continue;
    }
    let wait: Awaited<ReturnType<typeof waitForQuota>>;
    try {
      wait = await waitForQuota(d.clock, d.quota, d.stopAt, d.log);
    } catch (err) {
      // The reads were already retried: end the run, and let the store and publish stages run on what it has.
      stopped = `the quota couldn't be read: ${(err as Error).message.split('\n')[0]}`;
      break;
    }
    if (!wait.go) {
      stopped = wait.why;
      break;
    }
    let token: string;
    try {
      token = d.token();
    } catch (err) {
      stopped = `token.ts failed: ${(err as Error).message.split('\n')[0]}`;
      break;
    }

    if (e.since) {
      const at = new Date(d.clock.now()).toISOString();
      let read: { changed: boolean; calls: number } | null = null;
      try {
        read = await d.changedSince(e.repo, e.since, token);
        askCalls += read.calls;
      } catch (err) {
        d.log(`${at} ${e.reason} ${e.repo}: couldn't read its runs since ${e.since}, so it's measured: ${(err as Error).message.split('\n')[0]}`);
      }
      if (read && !read.changed) {
        const why = `no pull-request run since ${e.since}`;
        d.db.prepare(`INSERT OR REPLACE INTO skips (repo, at, since, why, calls) VALUES (?, ?, ?, ?, ?)`).run(e.repo, at, e.since, why, read.calls);
        unchanged.push(e.repo);
        d.log(`${at} ${e.reason} ${e.repo}: skipped, ${why}, ${read.calls} calls`);
        continue;
      }
    }

    // The read above can end at or past the stop time. No check starts then: its timeout would be zero, which Node
    // reads as none, or negative, which it refuses, and the run would end before its store and publish stages.
    if (d.clock.now() >= d.stopAt) {
      stopped = 'reached the stop time';
      break;
    }

    // No check runs past the stop time: its timeout is the smaller of 10 minutes and the time left.
    const at = new Date(d.clock.now()).toISOString();
    const res = await d.check(e.repo, token, Math.min(CHECK_TIMEOUT_MS, d.stopAt - d.clock.now()));
    const o = record(d, e, at, res, wait.quota);
    outcomes.push(o);
    d.log(`${at} ${e.reason} ${e.repo}: ${o.outcome}${o.error ? ` (${o.error})` : ''}, ${o.calls ?? '?'} calls`);
  }

  d.refreshRepos(d.db);
  // A new repo's GitHub id, from discovery, goes with its row.
  const setId = d.db.prepare(`UPDATE repos SET github_id = ? WHERE repo = ? AND github_id IS NULL`);
  for (const e of queue) if (e.githubId && outcomes.some((o) => o.repo === e.repo)) setId.run(e.githubId, e.repo);
  return { outcomes, present, unchanged, askCalls, stopped };
}

function record(d: RunDeps, e: Entry, at: string, res: CheckResult, before: Quota): Outcome {
  let report: string | null = null;
  let file: string | null = null;
  let error: string | null;
  let scored = 0;
  let calls: number | null;

  if ('report' in res) {
    const r = res.report;
    const dir = e.repo.replace('/', '__');
    file = `${dir}/${r.date}.json`;
    mkdirSync(join(d.reportsDir, dir), { recursive: true });
    writeFileSync(join(d.reportsDir, file), reportText(r));
    try {
      report = d.importOne(d.db, d.reportsDir, dir, `${r.date}.json`).id;
      d.readBy?.(report, at);
      scored = r.score === null || r.score === undefined ? 0 : 1;
      error = r.unscored ?? null;
    } catch (err) {
      error = `import failed: ${(err as Error).message}`;
    }
    calls = r.read?.calls ?? r.apiCalls ?? null;
  } else {
    error = res.error;
    // A failed check doesn't say what it spent: the quota's fall says, while the window is the same.
    try {
      const after = d.quota();
      calls = after.reset === before.reset ? before.remaining - after.remaining : null;
    } catch {
      calls = null;
    }
  }

  d.db
    .prepare(`INSERT OR REPLACE INTO checks (repo, at, reason, scored, report, error, calls) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(e.repo, at, e.reason, scored, report, error, calls);
  const outcome = report === null ? 'failed' : scored ? 'scored' : 'unscored';
  return { repo: e.repo, reason: e.reason, at, outcome, calls, error, file };
}

// The scorer in its own process, at the loop's checkout of ci-doctor's main, timed out after `timeoutMs`.
export function childCheck(scorerSrc: string) {
  return (repo: string, token: string, timeoutMs: number) =>
    new Promise<CheckResult>((resolve) => {
      execFile(
        'node',
        [join(import.meta.dirname, 'check.ts'), repo],
        { env: childEnv({ GH_TOKEN: token, CI_DOCTOR_SCORER: scorerSrc }), timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 << 20, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (!err) {
            try {
              return resolve({ report: JSON.parse(stdout) });
            } catch {
              return resolve({ error: 'the scorer printed no JSON' });
            }
          }
          if (err.killed) return resolve({ error: `timed out after ${Math.round(timeoutMs / 1000)} seconds` });
          resolve({ error: stderr.trim().split('\n')[0] || err.message.split('\n')[0]! });
        },
      );
    });
}

// The loop's own checkout of ci-doctor's main: cloned once, fast-forwarded each run, never the shared checkout.
function ensureScorer(log: (s: string) => void): string {
  const git = (...a: string[]) => execFileSync('git', ['-C', SCORER_CHECKOUT, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!existsSync(SCORER_CHECKOUT)) {
    execFileSync('git', ['clone', '-q', '--branch', 'main', SCORER_REMOTE, SCORER_CHECKOUT], { stdio: ['ignore', 'pipe', 'pipe'] });
    return `scorer: cloned main at ${git('rev-parse', '--short', 'HEAD')}`;
  }
  try {
    git('fetch', '-q', 'origin', 'main');
    git('merge', '-q', '--ff-only', 'origin/main');
  } catch (e) {
    log(`scorer: couldn't fast-forward: ${(e as Error).message.split('\n')[0]}`);
    return `scorer: main at ${git('rev-parse', '--short', 'HEAD')}, not fast-forwarded (see the log)`;
  }
  return `scorer: main at ${git('rev-parse', '--short', 'HEAD')}`;
}

const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);

async function main() {
  const unsafe = debugSettings();
  if (unsafe.length) throw new Error(`refusing to run with Node's debugging on, which would print the App's token: ${unsafe.join('; ')}`);

  // UTC, as the scorer dates its reports.
  const date = new Date().toISOString().slice(0, 10);
  const logs = join(ROOT, 'logs');
  mkdirSync(logs, { recursive: true });

  // The whole run holds the lock, so a second run started meanwhile exits at once.
  const lock = takeLock(runLock());
  if ('heldBy' in lock) throw new Error(`another measure run (pid ${lock.heldBy}) holds the lock; this one exits`);
  process.on('exit', lock.release);

  const logFile = join(logs, `measure-${date}.log`);
  const log = (s: string) => appendFileSync(logFile, s + '\n');
  const say = (s: string) => (console.log(s), log(s));
  const dryRun = process.argv.includes('--dry-run');
  const max = arg('--max') === undefined ? Infinity : Number(arg('--max'));
  const hours = arg('--hours') === undefined ? RUN_HOURS : Number(arg('--hours'));
  const stopAt = runStop(Date.now(), hours);
  log(`== ${new Date().toISOString()} measure${dryRun ? ' --dry-run' : ''}, max ${max}, ${hours} hours, stop at ${new Date(stopAt).toISOString()}`);

  say(ensureScorer(log));
  const { SCORER_SRC } = await import('../scorer.ts');
  const { importOne, refreshRepos, importReports } = await import('./import.ts');
  const { open, checkSchema } = await import('./db.ts');
  const { planWeek, describe } = await import('./queue.ts');
  const { appToken, coreQuota, liveGitHub, prRunsSince } = await import('./github.ts');
  const { prune, summary, DEFAULT_CACHE } = await import('./prune.ts');
  const { childReread, detectionOf, dueReports, recordReading, rereadDue, rereadLine } = await import('./reread.ts');
  // The practice detection this run's scorer has, which every report it measures, and every re-read, is read by.
  const detection = detectionOf(SCORER_SRC);

  // This checkout's reports/ and loop.db, so the data commit holds what the run wrote.
  const reportsDir = join(ROOT, 'reports');
  const dbPath = process.env.LOOP_DB ?? join(ROOT, 'loop.db');
  const db = open(dbPath);
  checkSchema(db, dbPath);
  const before = importReports(db, reportsDir);
  say(`store: ${before.files} report files in loop.db before the run, ${before.changes} rows changed`);

  // The run's size: what the budget allows in its hours, at a median check.
  const token = appToken();
  const q0 = coreQuota(token);
  const slots = Math.min(max, runSlots(q0.limit, hours));
  const gh = liveGitHub(token);
  // Discovery's core calls wait on the same quota guard as the checks.
  const guard = async () => {
    try {
      return (await waitForQuota(realClock, () => coreQuota(token), stopAt, log)).go;
    } catch {
      return false;
    }
  };
  const plan = await planWeek(db, { today: date, slots, gh: gh.api, log, guard });
  for (const l of describe(plan)) log(l);
  const byReason = (es: { reason: string }[]) => Object.entries(Object.groupBy(es, (e) => e.reason)).map(([r, xs]) => `${xs!.length} ${r}`).join(', ') || 'nothing';
  say(`queue: ${plan.queue.length} of ${slots} slots (${byReason(plan.queue)}); discovery ${gh.calls.core} core and ${gh.calls.graphql} GraphQL calls`);
  if (dryRun) {
    for (const l of describe(plan)) console.log(`  ${l}`);
    say(`reread: ${dueReports(db, detection).length} latest reports due for practice detection ${detection.slice(0, 12)}, less those the run measures`);
    return 0;
  }

  // A report for today on origin/main, such as a submission merged since this checkout last caught up, counts as stored.
  let onMain = new Set<string>();
  try {
    onMain = publishedReports(ROOT);
  } catch (e) {
    log(`measure: couldn't read origin/main's reports, so only this checkout's count as stored: ${(e as Error).message.split('\n')[0]}`);
  }
  const { outcomes, present, unchanged, askCalls, stopped } = await runWeek(plan.queue, {
    db, reportsDir, clock: realClock, stopAt, log,
    quota: () => coreQuota(appToken()),
    token: appToken,
    check: childCheck(SCORER_SRC),
    changedSince: (repo, since, t) => prRunsSince(t, repo, since),
    importOne,
    refreshRepos,
    stored: (file) => existsSync(join(reportsDir, file)) || onMain.has(`reports/${file}`),
    readBy: (report, at) => recordReading(db, report, detection, at, 'measure'),
  });
  const count = (o: Outcome['outcome']) => outcomes.filter((x) => x.outcome === o).length;
  const calls = outcomes.reduce((s, o) => s + (o.calls ?? 0), 0);
  say(
    `measure: ${outcomes.length} checks (${count('scored')} scored, ${count('unscored')} unscored, ${count('failed')} failed); ` +
      `${unchanged.length} skipped, no pull-request run since their last report (${askCalls} calls to ask); ${present.length} skipped, today's report already there; ` +
      `${calls} scorer calls + ${gh.calls.core} discovery core + ${gh.calls.graphql} GraphQL; stopped: ${stopped}`,
  );
  for (const o of outcomes.filter((x) => x.outcome === 'failed')) log(`failed ${o.repo}: ${o.error}`);

  // What the checks left of the hours and the quota goes to reports whose practices an older detection read.
  const reread = await rereadDue({
    db, reportsDir, detection, clock: realClock, stopAt, log,
    quota: () => coreQuota(appToken()),
    token: appToken,
    reread: childReread(SCORER_SRC),
    importOne,
  });
  say(rereadLine(reread));

  const after = importReports(db, reportsDir);
  say(`store: ${after.files} report files in loop.db, ${after.changes} rows changed by the import`);
  db.close();

  say(publish({ root: ROOT, scratch: SCRATCH, date, push: process.argv.includes('--push'), log }));

  const really = process.argv.includes('--prune');
  say(existsSync(DEFAULT_CACHE) ? summary(prune(DEFAULT_CACHE, { dryRun: !really }), !really) : 'prune: no cache/ here');
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`measure: the run couldn't start: ${(e as Error).message.split('\n')[0]}`);
      try {
        appendFileSync(join(ROOT, 'logs', `measure-${new Date().toISOString().slice(0, 10)}.log`), `${(e as Error).stack}\n`);
      } catch {}
      process.exit(1);
    },
  );
}
