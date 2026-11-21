// Pushing to the score site: every report loop.db has that the site's D1 lacks, or holds at another sha256, goes to the
// site's R2 bucket as its file, then to D1 as its row, with every repo's row and the checks D1 lacks. Files go first,
// so a row never names a file the bucket doesn't have. A second run with nothing new uploads nothing.
// It runs Wrangler, signed in to the account that owns the site, which CLOUDFLARE_ACCOUNT_ID names.
// Usage: node loop/site.ts [--db <file>] [--reports <dir>] [--dry-run]
//   --dry-run   says what it would upload and writes the SQL it would run, and changes nothing
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { promisify } from 'node:util';
import { DEFAULT_DB } from './db.ts';
import { DEFAULT_REPORTS } from './import.ts';

/** The site's D1 database and R2 bucket, both named for its Worker. */
export const SITE = 'ci-doctor-site';
const WRANGLER = process.env.WRANGLER ?? 'wrangler';
const SCRATCH = join(homedir(), '.cache', 'ci-loop-site');
const UPLOADS_AT_ONCE = 8;

type Row = Record<string, SQLOutputValue>;

/** One SQLite literal: text quoted with its quotes doubled, numbers as they are, nothing as NULL. */
export const literal = (value: SQLOutputValue): string =>
  value === null ? 'NULL' : typeof value === 'string' ? `'${value.replaceAll("'", "''")}'` : String(value);

/**
 * Rows of `table` written in or over D1's: an upsert on `key`, so a report D1 already has is changed in place, never
 * deleted, as a replace would, which a repo's `latest_report` or a check pointing at it forbids. `onlyNew` keeps D1's.
 */
export const upserts = (table: string, key: ReadonlyArray<string>, rows: ReadonlyArray<Row>, onlyNew = false) =>
  rows.map((row) => {
    const columns = Object.keys(row);
    const values = columns.map((c) => literal(row[c] ?? null)).join(', ');
    const set = columns.filter((c) => !key.includes(c)).map((c) => `${c} = excluded.${c}`);
    const conflict = onlyNew || set.length === 0 ? 'DO NOTHING' : `DO UPDATE SET ${set.join(', ')}`;
    return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values}) ON CONFLICT (${key.join(', ')}) ${conflict};`;
  });

/** The reports to send: those D1 lacks or holds at another sha256. */
export const changed = (local: ReadonlyArray<Row>, remote: ReadonlyMap<string, string>) =>
  local.filter((r) => remote.get(String(r.id)) !== r.sha256);

/**
 * The SQL that brings D1 to loop.db: the changed reports first, since repos and checks point at them, then every repo,
 * then the checks D1 lacks. A repo's row is sent whole each time; there are hundreds, not millions.
 */
export const siteSql = (reports: ReadonlyArray<Row>, repos: ReadonlyArray<Row>, checks: ReadonlyArray<Row>) =>
  [...upserts('reports', ['id'], reports), ...upserts('repos', ['repo'], repos), ...upserts('checks', ['repo', 'at', 'reason'], checks, true)].join('\n');

const wrangler = (args: string[]) =>
  execFileSync(WRANGLER, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });

/** D1's reports, by id, with the sha256 of the file each was imported from. */
function remoteShas(): Map<string, string> {
  const out = wrangler(['d1', 'execute', SITE, '--remote', '--json', '--command', 'SELECT id, sha256 FROM reports']);
  const [answer] = JSON.parse(out) as { results: { id: string; sha256: string }[] }[];
  return new Map((answer?.results ?? []).map((r) => [r.id, r.sha256]));
}

/**
 * Uploads each report's file to R2 at its path, a few at once. An upload that fails gets one more try, since a fetch
 * fails in transit now and then; a second failure stops the push before D1 changes.
 */
async function upload(paths: ReadonlyArray<string>, reports: string) {
  const run = promisify(execFile);
  const put = (path: string) =>
    run(WRANGLER, ['r2', 'object', 'put', `${SITE}/${path}`, '--remote', '--file', join(reports, path), '--content-type', 'application/json']);
  for (let i = 0; i < paths.length; i += UPLOADS_AT_ONCE) {
    await Promise.all(paths.slice(i, i + UPLOADS_AT_ONCE).map((path) => put(path).catch(() => put(path))));
    console.log(`  uploaded ${Math.min(i + UPLOADS_AT_ONCE, paths.length)} of ${paths.length}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const dryRun = args.includes('--dry-run');
  const reportsDir = flag('--reports') ?? DEFAULT_REPORTS;
  const db = new DatabaseSync(flag('--db') ?? DEFAULT_DB, { readOnly: true });

  const local = db.prepare('SELECT * FROM reports ORDER BY id').all();
  const send = changed(local, remoteShas());
  const sql = siteSql(send, db.prepare('SELECT * FROM repos ORDER BY repo').all(), db.prepare('SELECT * FROM checks ORDER BY repo, at').all());
  mkdirSync(SCRATCH, { recursive: true });
  const file = join(SCRATCH, 'push.sql');
  writeFileSync(file, sql);
  console.log(`${send.length} of ${local.length} reports to send; SQL in ${file}`);
  if (dryRun) return;

  await upload(send.map((r) => String(r.path)), reportsDir);
  wrangler(['d1', 'execute', SITE, '--remote', '--yes', '--file', file]);
  console.log(`D1 has ${remoteShas().size} reports`);
}

if (import.meta.main) await main();
