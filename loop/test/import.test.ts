import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { cohorts, counts, history, latestOf, open } from '../db.ts';
import { importReports, reportRow, type Misfit } from '../import.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');

function imported() {
  const db = open(':memory:');
  const result = importReports(db, FIXTURES);
  return { db, result };
}

const dump = (db: ReturnType<typeof open>) =>
  ['repos', 'reports', 'checks'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all());

test('every report file is a row, and each measured one a check', () => {
  const { db } = imported();

  assert.deepEqual({ ...counts(db) }, { repos: 3, reports: 6, scored: 2, unscored: 1, checks: 4 });
});

test('the newest file is the latest, a rescore after the report it rescored', () => {
  const { db } = imported();

  const vite = latestOf(db, 'vitejs/vite') as Record<string, unknown>;
  assert.equal(vite.id, 'vitejs/vite/2026-11-19_rescored');
  assert.equal(vite.score, 78);
  assert.equal(vite.rescored_from, 'vitejs/vite/2026-11-19');
  assert.equal(vite.score_was, 55);
  assert.equal((latestOf(db, 'astral-sh/ruff') as Record<string, unknown>).score, 66);

  assert.deepEqual(
    history(db, 'vitejs/vite').map((r) => r.id),
    ['vitejs/vite/2026-11-18', 'vitejs/vite/2026-11-19', 'vitejs/vite/2026-11-19_rescored'],
  );
});

test('repos count checks, not rescores', () => {
  const { db } = imported();

  const vite = db.prepare(`SELECT * FROM repos WHERE repo = 'vitejs/vite'`).get();
  assert.deepEqual({ ...vite }, {
    repo: 'vitejs/vite',
    first_seen: '2026-11-18',
    last_checked: '2026-11-19',
    times_checked: 2,
    latest_report: 'vitejs/vite/2026-11-19_rescored',
    github_id: null,
  });
});

test('an unscored report is kept, with why', () => {
  const { db } = imported();

  const r = latestOf(db, 'mitsuhiko/minijinja') as Record<string, unknown>;
  assert.equal(r.score, null);
  assert.match(String(r.unscored), /PR pushes in the window/);
  const check = db.prepare(`SELECT scored, error FROM checks WHERE repo = 'mitsuhiko/minijinja'`).get();
  assert.equal(check?.scored, 0);
  assert.equal(check?.error, r.unscored);
});

test('practices are columns and the stack is JSON', () => {
  const { db } = imported();

  const vite = latestOf(db, 'vitejs/vite') as Record<string, unknown>;
  assert.equal(vite.language, 'TypeScript');
  assert.equal(vite.size, 'medium');
  assert.equal(vite.cancel_in_progress, 1);
  assert.equal(vite.remote_cache, 0);
  assert.equal(vite.package_manager, 'pnpm');
  assert.equal(vite.grade, 'B');
  const stack = JSON.parse(String(vite.stack));
  assert.deepEqual(stack.languages[0], ['TypeScript', 84]);
  assert.deepEqual(stack.agentFiles, ['.github/copilot-instructions.md']);
});

test('a second import changes nothing', () => {
  const { db, result } = imported();
  const before = dump(db);

  const again = importReports(db, FIXTURES);

  assert.ok(result.changes > 0);
  assert.equal(again.changes, 0);
  assert.deepEqual(dump(db), before);
});

test('cohorts count latest scored reports, with nearest-rank percentiles', () => {
  const { db } = imported();

  const rows = cohorts(db).map((r) => ({ ...r }));
  assert.deepEqual(
    rows.sort((a, b) => a.language.localeCompare(b.language)),
    [
      { size: 'large', language: 'Rust', n: 1, p10: 66, p50: 66, p90: 66 },
      { size: 'medium', language: 'TypeScript', n: 1, p10: 78, p50: 78, p90: 78 },
    ],
  );
});

test("a published scorer's report keeps its own stack, with no misfits", () => {
  const stack = { languages: [['Rust', 97]], packages: { npm: 0, cargo: 3, go: 0, python: 0 }, workspace: { packageManagers: ['Cargo'], tools: ['Cargo workspace'] }, testRunners: ['cargo nextest'], lintFormat: ['Clippy'], libraries: [{ name: 'serde', ecosystem: 'cargo', packages: 2 }], runners: [['Depot', 12]], agentFiles: ['AGENTS.md'], unknown: [] };
  const report = { repo: 'pip/app', date: '2026-11-20', checkout: null, defaultBranch: 'main', score: 70, grade: 'C+', practices: { cancelInProgress: true, unknown: ['Read the first 40 of 45 workflow files'] }, stack, read: { calls: 40, fromCache: 0 } };
  const misfits: Misfit[] = [];

  const row = reportRow('pip__app', '2026-11-20.json', JSON.stringify(report), misfits);

  assert.deepEqual(misfits, []);
  assert.deepEqual(JSON.parse(String(row?.stack)), stack);
});

test('a submitted report keeps who sent it, and a measured one has nobody; neither has misfits', () => {
  const report = { repo: 'pip/garden', date: '2026-11-23', scorerVersion: '0.4.0', score: 70, grade: 'C+', practices: {}, stack: {}, evidence: {}, jobGraph: {}, graphs: {}, read: { calls: 40, fromCache: 0 } };
  const misfits: Misfit[] = [];

  const submitted = reportRow('pip__garden', '2026-11-23.json', JSON.stringify({ ...report, submitted: { by: 'pip', at: '2026-11-23T10:00:00Z' } }), misfits);
  const measured = reportRow('pip__garden', '2026-11-23.json', JSON.stringify(report), misfits);

  assert.deepEqual(misfits, []);
  assert.equal(submitted?.submitted_by, 'pip');
  assert.equal(measured?.submitted_by, null);
});

test("a report's practices.hints become hints rows, a second import changes none, and an entry of another shape is a misfit", async () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const scratch = process.env.LOOP_TEST_DIR ?? join(homedir(), '.cache', 'ci-loop-measure');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'hints-'));
  const hints = [
    { practice: 'remoteCache', path: '.github/workflows/ci.yml', kind: 'unknown-action' },
    { practice: 'affected', path: 'package.json', kind: 'script' },
  ];
  mkdirSync(join(dir, 'pip__garden'));
  writeFileSync(join(dir, 'pip__garden', '2026-11-29.json'), JSON.stringify({ repo: 'pip/garden', date: '2026-11-29', score: 70, grade: 'C+', practices: { hints: [...hints, { practice: 'x' }] }, stack: {} }));
  const db = open(':memory:');

  const first = importReports(db, dir);
  const again = importReports(db, dir);

  const rows = db.prepare(`SELECT report, practice, path, kind FROM hints ORDER BY practice`).all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { report: 'pip/garden/2026-11-29', ...hints[1] },
    { report: 'pip/garden/2026-11-29', ...hints[0] },
  ]);
  assert.deepEqual(first.misfits.map((m) => m.what), ['practices.hints holds something not { practice, path, kind }; left out']);
  assert.equal(again.changes, 0);
  assert.equal(JSON.parse(String((latestOf(db, 'pip/garden') as Record<string, unknown>).stack)).otherPractices, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('a loop.db older than schema.sql is named, with how to rebuild it', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { checkSchema, missingColumns } = await import('../db.ts');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE checks (repo TEXT NOT NULL, at TEXT NOT NULL, reason TEXT NOT NULL, scored INTEGER NOT NULL, report TEXT, error TEXT, PRIMARY KEY (repo, at, reason))`);
  db.exec(readFileSync(join(import.meta.dirname, '..', 'schema.sql'), 'utf8'));

  assert.deepEqual(missingColumns(db), ['checks.calls']);
  assert.throws(() => checkSchema(db, 'loop.db'), /no checks\.calls.*rm loop\.db && node loop\/import\.ts/);
  assert.doesNotThrow(() => checkSchema(open(':memory:'), 'x'));
});

test("a report changed in place, as a re-read of its practices leaves it, updates its row, practice columns and hints", async () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const scratch = process.env.LOOP_TEST_DIR ?? join(homedir(), '.cache', 'ci-loop-measure');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'in-place-'));
  const file = join(dir, 'pip__garden', '2026-11-22.json');
  const stored = { repo: 'pip/garden', date: '2026-11-22', score: 70, grade: 'C+', practices: { remoteCache: false, affected: false, hints: [{ practice: 'remoteCache', path: '.github/workflows/ci.yml', kind: 'unknown-action' }] }, stack: {} };
  mkdirSync(join(dir, 'pip__garden'));
  writeFileSync(file, JSON.stringify(stored, null, 1));
  const db = open(':memory:');
  importReports(db, dir);
  const was = db.prepare(`SELECT sha256 FROM reports`).get()!.sha256;

  const hints = [{ practice: 'affected', path: 'package.json', kind: 'script' }];
  writeFileSync(file, JSON.stringify({ ...stored, practices: { remoteCache: true, affected: null, hints, where: { remoteCache: '.github/actions/setup/action.yml' } }, practicesDate: '2026-11-29' }, null, 1));
  const again = importReports(db, dir);

  const row = db.prepare(`SELECT remote_cache, affected, sha256 FROM reports WHERE id = 'pip/garden/2026-11-22'`).get()!;
  assert.deepEqual([row.remote_cache, row.affected], [1, null]);
  assert.notEqual(row.sha256, was);
  assert.deepEqual(db.prepare(`SELECT practice, path, kind FROM hints`).all().map((h) => ({ ...h })), hints);
  assert.deepEqual(again.misfits, []);
  assert.equal(JSON.parse(String((latestOf(db, 'pip/garden') as Record<string, unknown>).stack)).otherPractices, undefined);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM checks`).get()!.n, 1);
  rmSync(dir, { recursive: true, force: true });
});
