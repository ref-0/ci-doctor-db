// Imports every stored report into loop.db: one row per report file, a check per measured report, and each repo's
// latest. Idempotent: a second run over the same files changes no rows.
// Usage: node loop/import.ts [--reports <dir>] [--db <file>]
//   or REPORTS=<dir> LOOP_DB=<file> node loop/import.ts
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { band, grade } from '../scorer.ts';
import { DEFAULT_DB, open } from './db.ts';

export const DEFAULT_REPORTS = process.env.REPORTS ?? join(homedir(), 'ref0-work', 'ci-score', 'reports');

// A report file's stem: its date, and `_rescored` when it re-scored that day's report.
const STEM = /^(\d{4}-\d{2}-\d{2})(_rescored)?$/;

const PRACTICES: Record<string, string> = {
  workflows: 'workflows',
  cancelInProgress: 'cancel_in_progress',
  pathFilters: 'path_filters',
  affected: 'affected',
  draftSkip: 'draft_skip',
  mergeQueue: 'merge_queue',
  scheduled: 'scheduled',
  depCache: 'dep_cache',
  remoteCache: 'remote_cache',
  compilerCache: 'compiler_cache',
  frozenInstall: 'frozen_install',
  shardsConfigured: 'shards_configured',
  timeouts: 'timeouts',
  fastLint: 'fast_lint',
  eslint: 'eslint',
  testResults: 'test_results',
  depBotsBatched: 'dep_bots_batched',
  agentRules: 'agent_rules',
  preCommit: 'pre_commit',
  packageManager: 'package_manager',
  testRunner: 'test_runner',
  taskRunner: 'task_runner',
};

// Top-level report fields the import reads or knowingly leaves in the JSON file.
const KNOWN = new Set([
  'repo', 'date', 'profile', 'window', 'size', 'headsPerWeek', 'score', 'grade', 'band', 'parts', 'detail',
  'efficiency', 'wait', 'main', 'botRunShare', 'jobs', 'tests', 'practices', 'fixes', 'notes', 'apiCalls',
  'rescored', 'unscored', 'checkout', 'defaultBranch', 'stack', 'read', 'submitted',
  // In the JSON file only: which scorer made it, and what the evidence and the graphs say.
  'scorerVersion', 'evidence', 'jobGraph', 'graphs',
]);

type Row = Record<string, SQLInputValue>;
export type Misfit = { path: string; what: string };

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const int = (x: unknown): number | null => (num(x) === null ? null : Math.round(x as number));
const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const flag = (x: unknown): number | null => (typeof x === 'boolean' ? Number(x) : null);

// One report file → its reports row, or a reason it doesn't fit.
export function reportRow(dir: string, file: string, text: string, misfits: Misfit[]): Row | null {
  const path = `${dir}/${file}`;
  const stem = file.replace(/\.json$/, '');
  const m = STEM.exec(stem);
  if (!m) {
    misfits.push({ path, what: 'file name is not <date>.json or <date>_rescored.json; skipped' });
    return null;
  }

  const r = JSON.parse(text);
  const repo = str(r.repo);
  if (!repo || repo.replace('/', '__') !== dir) {
    misfits.push({ path, what: `repo ${repo} doesn't match its folder; skipped` });
    return null;
  }
  if (r.date !== m[1]) misfits.push({ path, what: `date ${r.date} differs from the file name; the file name wins` });
  for (const k of Object.keys(r)) if (!KNOWN.has(k)) misfits.push({ path, what: `unknown field ${k}, left in the JSON` });

  const p = r.practices ?? {};
  const practices: Row = {};
  const otherPractices: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    // agentsMd is in the stack's agent files; unknown is why a practice is null, not a practice.
    if (k === 'agentsMd' || k === 'unknown') continue;
    const col = PRACTICES[k];
    if (!col) {
      otherPractices[k] = v;
      misfits.push({ path, what: `unknown practice ${k}, kept in stack.otherPractices` });
      continue;
    }
    practices[col] = typeof v === 'boolean' ? Number(v) : typeof v === 'number' ? v : str(v);
  }

  // The published scorer writes the stack; a research report's is put together from the same fields it reads.
  const stack: Record<string, unknown> = r.stack ?? {
    languages: r.profile?.languages ?? [],
    packages: r.profile?.packages ?? {},
    runners: r.jobs?.providers ?? [],
    agentFiles: p.agentsMd ?? [],
  };
  if (Object.keys(otherPractices).length) stack.otherPractices = otherPractices;

  // Grade and band follow the score on today's scale: older reports carry an older scale, and a rescore kept the
  // grade of the score it replaced.
  const score = int(r.score);
  if ((r.grade ?? null) !== grade(score)) misfits.push({ path, what: 'stored grade disagrees with its score; derived from the score' });

  const rescored = m[2] ? r.rescored : null;
  if (m[2] && !rescored) misfits.push({ path, what: 'a _rescored file with no rescored field' });

  return {
    id: `${repo}/${stem}`,
    repo,
    date: m[1],
    seq: m[2] ? 1 : 0,
    path,
    sha256: createHash('sha256').update(text).digest('hex'),
    rescored_from: rescored?.from ? `${repo}/${String(rescored.from).replace(/\.json$/, '')}` : null,
    score_was: int(rescored?.scoreWas),
    submitted_by: str(r.submitted?.by),

    window_days: num(r.window?.days),
    window_runs: int(r.window?.runs),
    window_truncated: flag(r.window?.truncated),

    score,
    unscored: str(r.unscored),
    grade: grade(score),
    band: band(score),
    speed: int(r.parts?.speed),
    reliability: int(r.parts?.reliability),
    efficiency: int(r.parts?.efficiency),

    size: str(r.size),
    lines: int(r.profile?.linesOfCode),
    language: str(r.profile?.languages?.[0]?.[0]),
    heads_per_week: num(r.headsPerWeek),
    heads: int(r.wait?.heads),
    wait_p50: num(r.wait?.p50),
    wait_p75: num(r.wait?.p75),
    wait_p90: num(r.wait?.p90),
    red_rate: num(r.wait?.redRate),
    passed_on_rerun_rate: num(r.wait?.passedOnRerunRate),
    main_red_rate: num(r.main?.redRate),
    job_minutes_per_merged_pr: num(r.efficiency?.jobMinutesPerMergedPr),
    runs_per_merged_pr: num(r.profile?.runsPerMergedPr),
    setup_share: num(r.jobs?.setupShare),
    queue_p90_sec: num(r.jobs?.queueP90Sec),
    bot_run_share: num(r.botRunShare),
    logs_read: int(r.tests?.logsRead),
    files_timed: int(r.tests?.filesTimed),
    api_calls: int(r.apiCalls),

    workflows: null, cancel_in_progress: null, path_filters: null, affected: null, draft_skip: null,
    merge_queue: null, scheduled: null, dep_cache: null, remote_cache: null, compiler_cache: null,
    frozen_install: null, shards_configured: null, timeouts: null, fast_lint: null, eslint: null,
    test_results: null, dep_bots_batched: null, agent_rules: null, pre_commit: null,
    package_manager: null, test_runner: null, task_runner: null,
    ...practices,

    stack: JSON.stringify(stack),
  };
}

// Upserts that touch a row only when something in it differs, so a re-import reports 0 changes.
function upsert(db: DatabaseSync, table: string, key: string[], row: Row): number {
  const cols = Object.keys(row);
  const rest = cols.filter((c) => !key.includes(c));
  const sql =
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ` +
    `ON CONFLICT (${key.join(', ')}) DO UPDATE SET ${rest.map((c) => `${c} = excluded.${c}`).join(', ')} ` +
    `WHERE ${rest.map((c) => `${table}.${c} IS NOT excluded.${c}`).join(' OR ')}`;
  return Number(db.prepare(sql).run(...cols.map((c) => row[c])).changes);
}

export function importReports(db: DatabaseSync, reportsDir: string = DEFAULT_REPORTS) {
  const misfits: Misfit[] = [];
  const rows: Row[] = [];
  for (const dir of readdirSync(reportsDir).sort()) {
    let files: string[];
    try {
      files = readdirSync(join(reportsDir, dir));
    } catch {
      continue;
    }
    for (const file of files.filter((f) => f.endsWith('.json')).sort()) {
      const row = reportRow(dir, file, readFileSync(join(reportsDir, dir, file), 'utf8'), misfits);
      if (row) rows.push(row);
    }
  }

  let changes = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) changes += upsert(db, 'reports', ['id'], row);

    // A report the measure job checked has its check already, with its reason and calls.
    const checked = new Set(
      (db.prepare(`SELECT report FROM checks WHERE reason != 'import' AND report IS NOT NULL`).all() as { report: string }[]).map((c) => c.report),
    );
    for (const row of rows) {
      if (row.seq !== 0 || checked.has(row.id as string)) continue;
      changes += upsert(db, 'checks', ['repo', 'at', 'reason'], {
        repo: row.repo,
        at: row.date,
        reason: 'import',
        scored: row.score === null ? 0 : 1,
        report: row.id,
        error: row.unscored,
      });
    }

    changes += refreshRepos(db);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { files: rows.length, changes, misfits };
}

// One report file the measure job just wrote, into its reports row. Its check and repo row are the caller's.
export function importOne(db: DatabaseSync, reportsDir: string, dir: string, file: string): { id: string; misfits: Misfit[] } {
  const misfits: Misfit[] = [];
  const row = reportRow(dir, file, readFileSync(join(reportsDir, dir, file), 'utf8'), misfits);
  if (!row) throw new Error(misfits.map((m) => m.what).join('; '));
  upsert(db, 'reports', ['id'], row);
  return { id: row.id as string, misfits };
}

// Each repo from its checks and reports: the newest report file wins as its latest. Times are days, as an import's
// checks are; the measure job's checks carry ISO times.
export function refreshRepos(db: DatabaseSync): number {
  return Number(
    db
      .prepare(
        `INSERT INTO repos (repo, first_seen, last_checked, times_checked, latest_report)
         SELECT c.repo, MIN(substr(c.at, 1, 10)), MAX(substr(c.at, 1, 10)), COUNT(*),
                (SELECT r.id FROM reports r WHERE r.repo = c.repo ORDER BY r.date DESC, r.seq DESC LIMIT 1)
           FROM checks c GROUP BY c.repo
         ON CONFLICT (repo) DO UPDATE SET
           first_seen = excluded.first_seen, last_checked = excluded.last_checked,
           times_checked = excluded.times_checked, latest_report = excluded.latest_report
         WHERE repos.first_seen IS NOT excluded.first_seen OR repos.last_checked IS NOT excluded.last_checked
            OR repos.times_checked IS NOT excluded.times_checked OR repos.latest_report IS NOT excluded.latest_report`,
      )
      .run().changes,
  );
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (import.meta.main) {
  const reportsDir = arg('--reports') ?? DEFAULT_REPORTS;
  const dbPath = arg('--db') ?? DEFAULT_DB;
  const db = open(dbPath);
  const { files, changes, misfits } = importReports(db, reportsDir);
  console.log(`${files} report files from ${reportsDir} into ${dbPath}: ${changes} rows changed`);
  const byWhat = new Map<string, number>();
  for (const m of misfits) byWhat.set(m.what, (byWhat.get(m.what) ?? 0) + 1);
  for (const [what, n] of byWhat) console.log(`  ${n} × ${what}`);
  db.close();
}
