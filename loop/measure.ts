// The nightly measure job: find, measure, store, publish. The scheduled task at 02:00 runs this and nothing else.
// It prints one summary line per stage, writes the detail to logs/measure-<date>.log, and exits non-zero only when the
// night couldn't run at all: no scorer checkout, no database or no token.
// Usage: node loop/measure.ts [--max <n>] [--until 05:00] [--dry-run] [--push] [--prune]
//   --dry-run   prints the queue with each repo's reason and checks nothing
//   --push      pushes the night's data commit to origin main (only from main); otherwise it stays local
//   --prune     really deletes the cache's old files; without it the prune stage only says what it would delete
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Quota } from './github.ts';
import type { Entry } from './queue.ts';

const ROOT = join(import.meta.dirname, '..');
export const SCORER_CHECKOUT = join(homedir(), 'ref0-work', 'ci-doctor-next');
const SCORER_REMOTE = 'https://github.com/ref-0/ci-doctor.git';

// The App's hourly limit is shared with the site once it's live: keep 1,000 spare, and room for a p90 check.
export const KEEP = 1_000;
export const CHECK_MEDIAN = 66;
export const CHECK_P90 = 103;
export const RESET_SLACK_MS = 30_000;
export const CHECK_TIMEOUT_MS = 600_000;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

// The next local hh:mm after `now`: started at 02:00, 05:00 is the same morning.
export function nextAt(now: number, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h!, m!, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Before each check: stop at the deadline, or wait for the quota's reset while it's low, as batch.sh does.
export async function waitForQuota(clock: Clock, quota: () => Quota, stopAt: number, log: (s: string) => void) {
  for (;;) {
    if (clock.now() >= stopAt) return { go: false as const, why: 'reached the stop time' };
    const q = quota();
    if (q.remaining >= KEEP + CHECK_P90) return { go: true as const, quota: q };
    const resume = q.reset * 1000 + RESET_SLACK_MS;
    if (resume >= stopAt) return { go: false as const, why: `quota ${q.remaining} is low until after the stop time` };
    log(`${new Date(clock.now()).toISOString()} quota ${q.remaining} < ${KEEP + CHECK_P90}, pausing ${Math.round((resume - clock.now()) / 1000)} seconds until the reset`);
    await clock.sleep(Math.max(0, resume - clock.now()));
  }
}

export type CheckResult = { report: Record<string, any> } | { error: string };

export interface NightDeps {
  db: DatabaseSync;
  reportsDir: string;
  clock: Clock;
  stopAt: number;
  quota: () => Quota;
  token: () => string;
  check: (repo: string, token: string) => Promise<CheckResult>;
  importOne: (db: DatabaseSync, reportsDir: string, dir: string, file: string) => { id: string };
  refreshRepos: (db: DatabaseSync) => number;
  log: (s: string) => void;
}

export type Outcome = { repo: string; reason: Entry['reason']; at: string; outcome: 'scored' | 'unscored' | 'failed'; calls: number | null; error: string | null; file: string | null };

// Checks the queue in order until it's done or the stop time. Every check is recorded, failures with their reason.
export async function runNight(queue: Entry[], d: NightDeps) {
  const outcomes: Outcome[] = [];
  let stopped = 'the queue is done';

  for (const e of queue) {
    const wait = await waitForQuota(d.clock, d.quota, d.stopAt, d.log);
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

    const at = new Date(d.clock.now()).toISOString();
    const res = await d.check(e.repo, token);
    const o = record(d, e, at, res, wait.quota);
    outcomes.push(o);
    d.log(`${at} ${e.reason} ${e.repo}: ${o.outcome}${o.error ? ` (${o.error})` : ''}, ${o.calls ?? '?'} calls`);
  }

  d.refreshRepos(d.db);
  return { outcomes, stopped };
}

function record(d: NightDeps, e: Entry, at: string, res: CheckResult, before: Quota): Outcome {
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
    writeFileSync(join(d.reportsDir, file), JSON.stringify(r, null, 1));
    try {
      report = d.importOne(d.db, d.reportsDir, dir, `${r.date}.json`).id;
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

// The scorer in its own process, at the loop's checkout of next, timed out after 10 minutes.
export function childCheck(scorerSrc: string) {
  return (repo: string, token: string) =>
    new Promise<CheckResult>((resolve) => {
      execFile(
        'node',
        [join(import.meta.dirname, 'check.ts'), repo],
        { env: { ...process.env, GH_TOKEN: token, CI_DOCTOR_SCORER: scorerSrc }, timeout: CHECK_TIMEOUT_MS, maxBuffer: 256 << 20, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (!err) {
            try {
              return resolve({ report: JSON.parse(stdout) });
            } catch {
              return resolve({ error: 'the scorer printed no JSON' });
            }
          }
          if (err.killed) return resolve({ error: `timed out after ${CHECK_TIMEOUT_MS / 60_000} minutes` });
          resolve({ error: stderr.trim().split('\n')[0] || err.message.split('\n')[0]! });
        },
      );
    });
}

// The loop's own checkout of ci-doctor's next: cloned once, fast-forwarded each night, never the shared checkout.
function ensureScorer(log: (s: string) => void): string {
  const git = (...a: string[]) => execFileSync('git', ['-C', SCORER_CHECKOUT, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!existsSync(SCORER_CHECKOUT)) {
    execFileSync('git', ['clone', '-q', '--branch', 'next', SCORER_REMOTE, SCORER_CHECKOUT], { stdio: ['ignore', 'pipe', 'pipe'] });
    return `scorer: cloned next at ${git('rev-parse', '--short', 'HEAD')}`;
  }
  try {
    git('fetch', '-q', 'origin', 'next');
    git('merge', '-q', '--ff-only', 'origin/next');
  } catch (e) {
    log(`scorer: couldn't fast-forward: ${(e as Error).message.split('\n')[0]}`);
    return `scorer: next at ${git('rev-parse', '--short', 'HEAD')}, not fast-forwarded (see the log)`;
  }
  return `scorer: next at ${git('rev-parse', '--short', 'HEAD')}`;
}

// The night's new reports, as one data commit on the current branch; pushed to main only from main.
function publish(files: string[], date: string, push: boolean, log: (s: string) => void): string {
  if (!files.length) return 'publish: no new reports';
  const git = (...a: string[]) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('add', '--', ...files.map((f) => join('reports', f)));
  const message = `Reports: ${files.length} checks on ${date}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  git('-c', 'user.name=mihar-22', '-c', 'user.email=14304599+mihar-22@users.noreply.github.com', 'commit', '-q', '-m', message, '--', ...files.map((f) => join('reports', f)));
  const sha = git('rev-parse', '--short', 'HEAD');
  const branch = git('branch', '--show-current');
  if (!push) return `publish: ${files.length} reports committed as ${sha} on ${branch}, not pushed`;
  if (branch !== 'main') return `publish: ${files.length} reports committed as ${sha} on ${branch}; --push pushes only from main`;
  try {
    git('push', '-q', 'origin', 'main');
  } catch (e) {
    log(`publish: push failed: ${(e as Error).message}`);
    return `publish: ${files.length} reports committed as ${sha}, push failed (see the log)`;
  }
  return `publish: ${files.length} reports pushed to main as ${sha}`;
}

const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);

async function main() {
  // UTC, as the scorer dates its reports.
  const date = new Date().toISOString().slice(0, 10);
  const logs = join(ROOT, 'logs');
  mkdirSync(logs, { recursive: true });
  const logFile = join(logs, `measure-${date}.log`);
  const log = (s: string) => appendFileSync(logFile, s + '\n');
  const say = (s: string) => (console.log(s), log(s));
  const dryRun = process.argv.includes('--dry-run');
  const max = arg('--max') === undefined ? Infinity : Number(arg('--max'));
  const stopAt = nextAt(Date.now(), arg('--until') ?? '05:00');
  log(`== ${new Date().toISOString()} measure${dryRun ? ' --dry-run' : ''}, max ${max}, stop at ${new Date(stopAt).toISOString()}`);

  say(ensureScorer(log));
  const { SCORER_SRC } = await import('../scorer.ts');
  const { importOne, refreshRepos, importReports } = await import('./import.ts');
  const { open } = await import('./db.ts');
  const { planNight, describe } = await import('./queue.ts');
  const { appToken, coreQuota, liveGitHub } = await import('./github.ts');
  const { prune, summary, DEFAULT_CACHE } = await import('./prune.ts');

  // This checkout's reports/ and loop.db, so the data commit holds what the night wrote.
  const reportsDir = join(ROOT, 'reports');
  const db = open(process.env.LOOP_DB ?? join(ROOT, 'loop.db'));
  const before = importReports(db, reportsDir);
  say(`store: ${before.files} report files in loop.db before the night, ${before.changes} rows changed`);

  // The night's size: what the budget allows until the stop time, at a median check.
  const token = appToken();
  const q0 = coreQuota(token);
  const hours = (stopAt - Date.now()) / 3_600_000;
  const slots = Math.min(max, Math.floor((Math.max(0, q0.limit - KEEP) * Math.min(hours, 24)) / CHECK_MEDIAN));
  const gh = liveGitHub(token);
  const plan = planNight(db, { today: date, slots, gh: gh.api, log });
  for (const l of describe(plan)) log(l);
  const byReason = (es: { reason: string }[]) => Object.entries(Object.groupBy(es, (e) => e.reason)).map(([r, xs]) => `${xs!.length} ${r}`).join(', ') || 'nothing';
  say(`queue: ${plan.queue.length} of ${slots} slots (${byReason(plan.queue)}); discovery ${gh.calls.core} core and ${gh.calls.graphql} GraphQL calls`);
  if (dryRun) {
    for (const l of describe(plan)) console.log(`  ${l}`);
    return 0;
  }

  const { outcomes, stopped } = await runNight(plan.queue, {
    db, reportsDir, clock: realClock, stopAt, log,
    quota: () => coreQuota(appToken()),
    token: appToken,
    check: childCheck(SCORER_SRC),
    importOne,
    refreshRepos,
  });
  const count = (o: Outcome['outcome']) => outcomes.filter((x) => x.outcome === o).length;
  const calls = outcomes.reduce((s, o) => s + (o.calls ?? 0), 0);
  say(`measure: ${outcomes.length} checks (${count('scored')} scored, ${count('unscored')} unscored, ${count('failed')} failed), ${calls} scorer calls + ${gh.calls.core} discovery core + ${gh.calls.graphql} GraphQL; stopped: ${stopped}`);
  for (const o of outcomes.filter((x) => x.outcome === 'failed')) log(`failed ${o.repo}: ${o.error}`);

  const after = importReports(db, reportsDir);
  say(`store: ${after.files} report files in loop.db, ${after.changes} rows changed by the import`);
  db.close();

  say(publish(outcomes.flatMap((o) => (o.file ? [o.file] : [])), date, process.argv.includes('--push'), log));

  const really = process.argv.includes('--prune');
  say(existsSync(DEFAULT_CACHE) ? summary(prune(DEFAULT_CACHE, { dryRun: !really }), !really) : 'prune: no cache/ here');
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`measure: the night couldn't run: ${(e as Error).message.split('\n')[0]}`);
      try {
        appendFileSync(join(ROOT, 'logs', `measure-${new Date().toISOString().slice(0, 10)}.log`), `${(e as Error).stack}\n`);
      } catch {}
      process.exit(1);
    },
  );
}
