// loop.db: opening it, applying the schema, and the queries the compare step builds on.
// The SQL here sticks to what D1 runs too: window functions, integer maths, no extensions.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_DB = process.env.LOOP_DB ?? join(homedir(), 'ref0-work', 'ci-score', 'loop.db');
const SCHEMA = join(import.meta.dirname, 'schema.sql');

export function open(path: string = DEFAULT_DB): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(readFileSync(SCHEMA, 'utf8'));
  return db;
}

// Each repo's latest report, scored or not.
export function latestReports(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT r.* FROM repos p JOIN reports r ON r.id = p.latest_report ORDER BY p.repo`,
    )
    .all();
}

export function latestOf(db: DatabaseSync, repo: string) {
  return db
    .prepare(`SELECT r.* FROM repos p JOIN reports r ON r.id = p.latest_report WHERE p.repo = ?`)
    .get(repo);
}

// A repo's reports, oldest first, a rescore after the report it rescored.
export function history(db: DatabaseSync, repo: string) {
  return db
    .prepare(
      `SELECT id, date, seq, score, unscored, speed, reliability, efficiency, wait_p50, wait_p90,
              job_minutes_per_merged_pr
         FROM reports WHERE repo = ? ORDER BY date, seq`,
    )
    .all(repo);
}

export function counts(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM repos) AS repos,
              (SELECT COUNT(*) FROM reports) AS reports,
              (SELECT COUNT(*) FROM repos p JOIN reports r ON r.id = p.latest_report WHERE r.score IS NOT NULL) AS scored,
              (SELECT COUNT(*) FROM repos p JOIN reports r ON r.id = p.latest_report WHERE r.score IS NULL) AS unscored,
              (SELECT COUNT(*) FROM checks) AS checks`,
    )
    .get() as { repos: number; reports: number; scored: number; unscored: number; checks: number };
}

// Columns a cohort's percentiles can be taken over. Names go into SQL, so only these.
const METRICS = ['score', 'wait_p50', 'wait_p90', 'job_minutes_per_merged_pr', 'speed', 'reliability', 'efficiency'] as const;
export type Metric = (typeof METRICS)[number];

// Cohorts of repos by size class × main language, over each repo's latest scored report:
// n, and nearest-rank p10/p50/p90 of the metric.
export function cohorts(db: DatabaseSync, metric: Metric = 'score') {
  if (!METRICS.includes(metric)) throw new Error(`not a cohort metric: ${metric}`);
  return db
    .prepare(
      `WITH latest AS (
         SELECT r.size, r.language, r.${metric} AS v
           FROM repos p JOIN reports r ON r.id = p.latest_report
          WHERE r.score IS NOT NULL AND r.${metric} IS NOT NULL
       ),
       ranked AS (
         SELECT size, language, v,
                ROW_NUMBER() OVER (PARTITION BY size, language ORDER BY v) AS rn,
                COUNT(*) OVER (PARTITION BY size, language) AS n
           FROM latest
       )
       SELECT size, language, n,
              MAX(CASE WHEN rn = MAX(1, (10 * n + 99) / 100) THEN v END) AS p10,
              MAX(CASE WHEN rn = MAX(1, (50 * n + 99) / 100) THEN v END) AS p50,
              MAX(CASE WHEN rn = MAX(1, (90 * n + 99) / 100) THEN v END) AS p90
         FROM ranked
        GROUP BY size, language
        ORDER BY n DESC, size, language`,
    )
    .all() as { size: string; language: string; n: number; p10: number; p50: number; p90: number }[];
}
