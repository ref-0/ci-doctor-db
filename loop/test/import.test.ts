import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
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
