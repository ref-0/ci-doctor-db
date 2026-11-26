// Reading practices again: each tracked repo's latest report, read again by the scorer's current practice detection
// (rereadPractices) when the detection has changed since that report's practices were read, and written back in place.
// The measure run does this after its checks, for the repos it didn't just measure; this file is that stage, and the
// same as a command.
//
// When one is due: `readings` in loop.db names, for each report, the practice detection that last read its practices,
// as `detectionOf`'s sha256 of the detection's code. The measure run writes a row for each report it measures, and a
// re-read writes one for the report it rewrites. A latest report is due when no row names it with the detection the
// scorer has now: so a report read by the current code is never read again, a change to that code makes every older
// reading due, and a report with no row, such as one stored before readings were kept or one submitted, is due once.
// A re-read that fails leaves the report as it was, with no row, so it's due again next run.
//
// Usage: node loop/reread.ts [--all] [--max <n>] [--dry-run] [--push] [--reports <dir>] [--db <file>]
//   --all       reads every latest report, whatever readings says
//   --max       the most it reads (default: every one due)
//   --dry-run   lists what's due and reads nothing
//   --push      pushes every report origin/main lacks, or holds as HEAD does while it changed here, to main (publish.ts)
//   --reports, --db   another reports/ and loop.db than this checkout's; then nothing is published
// It reads with GH_TOKEN when that's set, and otherwise the ref0-ci-doctor App's token. It holds the measure run's
// lock, so the two never overlap.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { childEnv, debugSettings } from './env.ts';
import type { Quota } from './github.ts';
import { runLock, takeLock } from './lock.ts';
import { CHECK_TIMEOUT_MS, realClock, reportText, waitForQuota, type CheckResult, type Clock } from './measure.ts';

const ROOT = join(import.meta.dirname, '..');
const SCRATCH = join(homedir(), '.cache', 'ci-loop-measure');

// The scorer's practice detection, as one sha256 of everything a re-read runs: index.ts, the entry it's called through,
// and each module it imports code from, in turn, so score.ts (the history it supplies, its fixes and notes), source.ts
// (how files are fetched) and practices.ts with theirs. Each file counts by its path from the scorer's src/ and its
// bytes, in path order, so the hash is the same on every machine. Type-only imports change no verdict, so they're left
// out; a hash a little too wide only costs a re-read's calls, where one too narrow leaves wrong verdicts up.
const IMPORT = /^(?:import|export)\s+(?!type\s)[^'";]*?\bfrom\s+'(\.\.?\/[\w./-]+\.ts)'/gm;

export function detectionOf(scorerSrc: string): string {
  const files = new Map<string, Buffer>();
  const visit = (name: string) => {
    if (files.has(name)) return;
    const bytes = readFileSync(join(scorerSrc, name));
    files.set(name, bytes);
    for (const m of bytes.toString('utf8').matchAll(IMPORT)) visit(posix.normalize(posix.join(posix.dirname(name), m[1]!)));
  };
  visit('index.ts');

  const hash = createHash('sha256');
  for (const name of [...files.keys()].sort()) hash.update(`${name}\0`).update(files.get(name)!).update('\0');
  return hash.digest('hex');
}

// A report is rewritten by writing a sibling, then renaming it over the report, so a kill mid-write leaves the report
// whole. The sibling's name starts with a dot and doesn't end in .json, so import, publish and the site never take it
// for a report, and a run removes any a killed one left behind before it reads.
const PARTIAL = /^\..*\.json\.partial-\d+$/;
export const partialOf = (file: string) => join(dirname(file), `.${basename(file)}.partial-${process.pid}`);

export function writeWhole(file: string, text: string) {
  const partial = partialOf(file);
  try {
    writeFileSync(partial, text);
    renameSync(partial, file);
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
}

export function clearPartials(reportsDir: string) {
  for (const d of readdirSync(reportsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(reportsDir, d.name))) if (PARTIAL.test(f)) rmSync(join(reportsDir, d.name, f), { force: true });
  }
}

export type Due = { id: string; repo: string; path: string };

// Each tracked repo's latest report whose practices `detection` hasn't read, or every one with `all`. A repo whose every
// report was submitted isn't tracked, as the queue has it: what it costs to read is its submitter's.
export function dueReports(db: DatabaseSync, detection: string, all = false): Due[] {
  return db
    .prepare(
      `SELECT r.id, r.repo, r.path FROM repos p JOIN reports r ON r.id = p.latest_report
        WHERE EXISTS (SELECT 1 FROM reports m WHERE m.repo = p.repo AND m.submitted_by IS NULL)
          AND (? OR NOT EXISTS (SELECT 1 FROM readings g WHERE g.report = r.id AND g.detection = ?))
        ORDER BY p.repo`,
    )
    .all(all ? 1 : 0, detection) as Due[];
}

// That `detection` read the report's practices at `at`: by the measure run that wrote it, or by a re-read.
export function recordReading(db: DatabaseSync, report: string, detection: string, at: string, how: 'measure' | 'reread', changed: number | null = null) {
  db.prepare(`INSERT OR REPLACE INTO readings (report, detection, at, how, changed) VALUES (?, ?, ?, ?, ?)`).run(report, detection, at, how, changed);
}

// The practices whose verdict differs between two readings. The workflow count, hints, the unknowns' reasons, where each
// was found and the agent files aren't verdicts.
const NOT_VERDICTS = new Set(['workflows', 'hints', 'unknown', 'where', 'agentsMd']);
export type Change = { practice: string; was: unknown; now: unknown };

export function verdictChanges(before: Record<string, unknown> = {}, after: Record<string, unknown> = {}): Change[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !NOT_VERDICTS.has(k));
  return keys
    .filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
    .map((k) => ({ practice: k, was: before[k] ?? null, now: after[k] ?? null }));
}

// A stored report's file, read again by the scorer in its own process, timed out after `timeoutMs`.
export type Reread = (file: string, token: string, timeoutMs: number) => Promise<CheckResult>;

export function childReread(scorerSrc: string): Reread {
  return (file, token, timeoutMs) =>
    new Promise<CheckResult>((resolve) => {
      execFile(
        'node',
        [join(import.meta.dirname, 'check.ts'), '--practices', file],
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

export interface RereadDeps {
  db: DatabaseSync;
  reportsDir: string;
  detection: string;
  clock: Clock;
  stopAt: number;
  quota: () => Quota;
  token: () => string;
  reread: Reread;
  importOne: (db: DatabaseSync, reportsDir: string, dir: string, file: string) => { id: string };
  log: (s: string) => void;
  all?: boolean;
  max?: number;
}

export type RereadResult = { due: number; read: number; changed: number; failed: number; left: number; calls: number; stopped: string };

// Reads what's due, in order, until it's done, at `max`, or at the stop time, each behind the quota guard as a check
// is. A report read again is written back in place, as the measure run writes one, and imported, so its row, practice
// columns and hints follow the file; its reading is recorded. A read that fails, or a file that won't import, leaves
// the stored report as it was.
export async function rereadDue(d: RereadDeps): Promise<RereadResult> {
  clearPartials(d.reportsDir);
  const due = dueReports(d.db, d.detection, d.all);
  const max = Math.min(due.length, d.max ?? Infinity);
  const r: RereadResult = { due: due.length, read: 0, changed: 0, failed: 0, left: 0, calls: 0, stopped: 'every due report was read' };
  let tried = 0;

  for (; tried < max; tried++) {
    const e = due[tried]!;
    let wait: Awaited<ReturnType<typeof waitForQuota>>;
    try {
      wait = await waitForQuota(d.clock, d.quota, d.stopAt, d.log);
    } catch (err) {
      r.stopped = `the quota couldn't be read: ${(err as Error).message.split('\n')[0]}`;
      break;
    }
    if (!wait.go) {
      r.stopped = wait.why;
      break;
    }
    let token: string;
    try {
      token = d.token();
    } catch (err) {
      r.stopped = `token.ts failed: ${(err as Error).message.split('\n')[0]}`;
      break;
    }

    // As for a check: none starts at or past the stop time, where its timeout would be zero or less.
    if (d.clock.now() >= d.stopAt) {
      r.stopped = 'reached the stop time';
      break;
    }

    const at = new Date(d.clock.now()).toISOString();
    const file = join(d.reportsDir, e.path);
    let text: string;
    let stored: Record<string, any>;
    try {
      text = readFileSync(file, 'utf8');
      stored = JSON.parse(text);
    } catch (err) {
      r.failed++;
      d.log(`${at} reread ${e.id}: failed, couldn't read ${e.path} (${(err as Error).message.split('\n')[0]})`);
      continue;
    }
    if (typeof stored.repo !== 'string') {
      d.log(`${at} reread ${e.id}: left as it is, it names no GitHub repo`);
      continue;
    }

    const res = await d.reread(file, token, Math.min(CHECK_TIMEOUT_MS, d.stopAt - d.clock.now()));
    try {
      const after = d.quota();
      if (after.reset === wait.quota.reset) r.calls += wait.quota.remaining - after.remaining;
    } catch {}
    if ('error' in res) {
      r.failed++;
      d.log(`${at} reread ${e.id}: failed, left as it was (${res.error})`);
      continue;
    }

    const changes = verdictChanges(stored.practices, res.report.practices);
    try {
      writeWhole(file, reportText(res.report));
    } catch (err) {
      r.failed++;
      d.log(`${at} reread ${e.id}: failed, left as it was (couldn't write it: ${(err as Error).message.split('\n')[0]})`);
      continue;
    }
    try {
      d.importOne(d.db, d.reportsDir, basename(dirname(file)), basename(file));
    } catch (err) {
      writeWhole(file, text);
      r.failed++;
      d.log(`${at} reread ${e.id}: failed, left as it was (import failed: ${(err as Error).message})`);
      continue;
    }
    recordReading(d.db, e.id, d.detection, at, 'reread', changes.length);
    r.read++;
    if (changes.length) r.changed++;
    d.log(`${at} reread ${e.id}: ${changes.length} verdicts changed`);
    for (const c of changes) d.log(`  changed ${e.repo} ${c.practice}: ${JSON.stringify(c.was)} -> ${JSON.stringify(c.now)}`);
  }

  if (tried === max && max < due.length) r.stopped = `reached --max ${max}`;
  // Every due report not read is due again: those not reached, those that failed and those left as they are.
  r.left = due.length - r.read;
  return r;
}

export const rereadLine = (r: RereadResult) =>
  `reread: ${r.read} of ${r.due} due reports' practices read again (${r.changed} with a verdict changed, ${r.failed} failed); ` +
  `${r.left} left for the next run; ${r.calls} calls; stopped: ${r.stopped}`;

const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);

async function main() {
  const unsafe = debugSettings();
  if (unsafe.length) throw new Error(`refusing to run with Node's debugging on, which would print the token: ${unsafe.join('; ')}`);

  const date = new Date().toISOString().slice(0, 10);
  const logs = join(ROOT, 'logs');
  mkdirSync(logs, { recursive: true });
  const lock = takeLock(runLock());
  if ('heldBy' in lock) throw new Error(`a measure run or another re-read (pid ${lock.heldBy}) holds the lock; this one exits`);
  process.on('exit', lock.release);

  const logFile = join(logs, `reread-${date}.log`);
  const log = (s: string) => appendFileSync(logFile, s + '\n');
  const say = (s: string) => (console.log(s), log(s));
  const all = process.argv.includes('--all');
  const dryRun = process.argv.includes('--dry-run');
  const max = arg('--max') === undefined ? Infinity : Number(arg('--max'));
  const reportsDir = arg('--reports') ?? join(ROOT, 'reports');
  const dbPath = arg('--db') ?? process.env.LOOP_DB ?? join(ROOT, 'loop.db');
  log(`== ${new Date().toISOString()} reread${all ? ' --all' : ''}${dryRun ? ' --dry-run' : ''}, max ${max}`);

  const { SCORER_SRC } = await import('../scorer.ts');
  const { importOne, importReports } = await import('./import.ts');
  const { open, checkSchema } = await import('./db.ts');
  const { appToken, coreQuota } = await import('./github.ts');
  const { publish } = await import('./publish.ts');

  const detection = detectionOf(SCORER_SRC);
  const db = open(dbPath);
  checkSchema(db, dbPath);
  const before = importReports(db, reportsDir);
  say(`store: ${before.files} report files in loop.db, ${before.changes} rows changed`);
  const due = dueReports(db, detection, all);
  say(`reread: ${due.length} latest reports due for practice detection ${detection.slice(0, 12)}`);
  if (dryRun) {
    for (const e of due.slice(0, max)) console.log(`  ${e.id}`);
    return 0;
  }

  const token = process.env.GH_TOKEN ? () => process.env.GH_TOKEN! : appToken;
  const result = await rereadDue({
    db, reportsDir, detection, clock: realClock, stopAt: Infinity, log, all, max,
    quota: () => coreQuota(token()),
    token,
    reread: childReread(SCORER_SRC),
    importOne,
  });
  say(rereadLine(result));
  const after = importReports(db, reportsDir);
  say(`store: ${after.files} report files in loop.db, ${after.changes} rows changed by the import`);
  db.close();

  if (reportsDir !== join(ROOT, 'reports')) say('publish: --reports names another folder, so nothing is published');
  else say(publish({ root: ROOT, scratch: SCRATCH, date, push: process.argv.includes('--push'), log }));
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`reread: couldn't start: ${(e as Error).message.split('\n')[0]}`);
      process.exit(1);
    },
  );
}
