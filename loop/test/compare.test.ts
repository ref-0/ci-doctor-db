import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { open } from '../db.ts';
import { importReports } from '../import.ts';
import { compare, pct, trustedLabels, type Digest, type Labels } from '../compare.ts';
import { NARRATIVE_END, NARRATIVE_START, render } from '../digest.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
// A second measured report for ruff a week on, with a remote cache turned on and a 40% shorter p50.
const LATER = join(import.meta.dirname, 'fixtures-later');
const NO_LABELS: Labels = new Map();

function fixtureDb({ later = true } = {}) {
  const db = open(':memory:');
  importReports(db, FIXTURES);
  if (later) importReports(db, LATER);
  return db;
}

// A made-up repo copied from another's latest report, so cohorts reach their minimum sizes.
function clone(db: DatabaseSync, from: string, repo: string, set: Record<string, number | string | null>) {
  const src = db.prepare(`SELECT r.* FROM repos p JOIN reports r ON r.id = p.latest_report WHERE p.repo = ?`).get(from) as Record<string, unknown>;
  const row = { ...src, ...set, id: `${repo}/${src.date}`, repo, seq: 0, rescored_from: null, score_was: null };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO reports (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c as keyof typeof row] as never));
  db.prepare(`INSERT INTO repos VALUES (?, ?, ?, 1, ?)`).run(repo, src.date as string, src.date as string, row.id);
}

const run = (db: DatabaseSync, labels = NO_LABELS, previous: Digest | null = null) =>
  compare(db, { date: '2026-11-26', labels, previous }) as Digest;

test('nearest-rank percentiles, as db.ts takes them', () => {
  assert.equal(pct([5, 1, 3, 2, 4], 50), 3);
  assert.equal(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(pct([7], 10), 7);
  assert.equal(pct([], 50), null);
});

test('a repo that changed a practice and moved past the threshold is a mover, with what changed', () => {
  const d = run(fixtureDb());

  assert.equal(d.movers.pairs, 2);
  assert.equal(d.movers.rows.length, 1);
  const [ruff] = d.movers.rows;
  assert.equal(ruff.repo, 'astral-sh/ruff');
  assert.deepEqual([ruff.from, ruff.to], ['2026-11-18', '2026-11-25']);
  assert.equal(ruff.change, -0.4);
  assert.deepEqual(ruff.changed.practices, { remote_cache: [0, 1] });
  assert.deepEqual(ruff.changed.stack, {});
  assert.deepEqual(ruff.changed.runners, {});
});

test('noise counts only repos whose practices and stack held, and the threshold is a placeholder until 20', () => {
  const d = run(fixtureDb());

  assert.equal(d.noise.n, 1);
  assert.deepEqual(d.noise.repos, [{ repo: 'vitejs/vite', from: '2026-11-18', to: '2026-11-19', change: -0.017 }]);
  assert.equal(d.noise.placeholder, true);
  assert.equal(d.noise.threshold, 0.25);
  assert.match(d.noise.note, /placeholder/);
});

test('with no repo measured twice, movers are empty and say so', () => {
  const db = open(':memory:');
  importReports(db, FIXTURES);
  db.exec(`DELETE FROM checks WHERE report = 'vitejs/vite/2026-11-18'; DELETE FROM reports WHERE id = 'vitejs/vite/2026-11-18'`);

  const d = run(db);

  assert.deepEqual(d.movers.rows, []);
  assert.equal(d.noise.n, 0);
  assert.match(d.movers.note, /no repo has two measured reports yet/);
});

test('cohorts under 5 are skipped and counted; kept ones carry their traits', () => {
  const db = fixtureDb();
  for (let i = 0; i < 4; i++) clone(db, 'vitejs/vite', `pip/site-${i}`, { wait_p50: 2 + i, score: 80 + i, remote_cache: i % 2 });

  const d = run(db);

  assert.deepEqual(d.cohorts.rows.map((c) => [c.size, c.language, c.n]), [['medium', 'TypeScript', 5]]);
  assert.deepEqual(d.cohorts.skipped, { cohorts: 1, repos: 1, traits: d.cohorts.skipped.traits });
  const [ts] = d.cohorts.rows;
  assert.deepEqual(ts.wait_p50, { p10: 2, p50: 4, p90: 5 });
  assert.deepEqual(ts.score, { p10: 78, p50: 81, p90: 83 });
  const pnpm = ts.traits.find((t) => t.trait === 'package_manager=pnpm');
  assert.equal(pnpm?.n, 5);
  assert.equal(ts.traits.find((t) => t.trait === 'remote_cache'), undefined, 'two with a remote cache is under 5');
});

test('practice effects need a cohort of 10, give n on each side, and are correlations', () => {
  const db = fixtureDb();
  for (let i = 0; i < 9; i++) clone(db, 'vitejs/vite', `mo/app-${i}`, { dep_cache: i < 5 ? 1 : 0, wait_p50: i < 5 ? 10 : 20 });

  const d = run(db);

  const dep = d.effects.rows.find((r) => r.practice === 'dep_cache' && r.language === 'TypeScript');
  // vite itself has a dependency cache and a 4.8 min p50: six with, four without.
  assert.deepEqual(dep && { with: dep.with, without: dep.without, ratio: dep.ratio, ranked: dep.ranked, kind: dep.kind }, {
    with: { n: 6, wait_p50: 10 },
    without: { n: 4, wait_p50: 20 },
    ratio: 0.5,
    ranked: false,
    kind: 'correlation',
  });
  assert.ok(d.effects.rows.every((r) => r.language === 'TypeScript'), 'large × Rust has 1 repo, under 10');
});

test('separation follows the trusted labels: fast at 75+, slow under 50', () => {
  const labels: Labels = new Map([['vitejs/vite', 'fast'], ['astral-sh/ruff', 'slow']]);

  const d = run(fixtureDb({ later: false }), labels);

  assert.deepEqual(d.score.separation.fast, { n: 1, at75: 1, share: 1 });
  assert.deepEqual(d.score.separation.slow, { n: 1, under50: 0, share: 0 });
  assert.deepEqual(d.score.separation.misses, [{ repo: 'astral-sh/ruff', label: 'slow', score: 66, wait_p50: 19.1 }]);
});

test('trusted labels drop the well-run slice and every repo sets.py names, and read quoted CSV', () => {
  const csv = [
    'repo,slice,expected,why',
    'a/fast,breadth,fast,"short, measured"',
    'b/slow,breadth,slow,"a ""slow"" one\nover two lines"',
    'c/wellrun,well-run,fast,practices',
    'd/distrusted,breadth,slow,label disagrees',
    'e/failing,breadth,slow,fails',
    'f/none,breadth,,no label',
  ].join('\n');
  const sets = `DISTRUST = {'slice:well-run': 'x', 'd/distrusted': 'y'}\nFAILING = {'e/failing'}\n`;

  assert.deepEqual([...trustedLabels(csv, sets)], [['a/fast', 'fast'], ['b/slow', 'slow']]);
});

test('probe health reads timings, unscored reasons without their numbers, and API calls', () => {
  const d = run(fixtureDb({ later: false }));

  assert.deepEqual({ n: d.probe.test_timings.n, timed: d.probe.test_timings.timed }, { n: 2, timed: 2 });
  assert.deepEqual(d.probe.test_timings.by_test_runner.map((r) => r.value).sort(), ['nextest', 'vitest']);
  assert.equal(d.probe.checks.failed.n, 0);
  assert.deepEqual(d.probe.checks.unscored.why, [{ value: 'Only N PR pushes in the window ran the main workflows; N are needed.', n: 1 }]);
  assert.deepEqual(d.probe.api_calls, { n: 2, p50: 14, p90: 19 });
  assert.deepEqual(d.adoption, { n: 0, rows: [], note: 'no adoption signals yet' });
});

test('the digest leads with what changed, gives n with its numbers, and leaves the narrative to the learn job', () => {
  const first = run(fixtureDb({ later: false }));
  const second = { ...run(fixtureDb()), date: '2026-11-26', previous: '2026-11-19' } as Digest;
  first.date = '2026-11-19';

  const md = render(second, first);

  const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, [
    'Since the 2026-11-19 digest',
    'Health of the probe',
    'Health of the score',
    'Practice effects, top 5',
    'Movers',
    'Cohorts',
    'Adoption',
    'Narrative and proposals',
  ]);
  assert.match(md, /\*\*Repos\*\* 3 \(\+0\)/);
  assert.match(md, /\*\*astral-sh\/ruff\*\* 2026-11-18 → 2026-11-25: p50 19\.1 → 11\.5 min \(-40%\).*remote_cache 0 → 1/);
  assert.match(md, /Correlations, not causes/);
  assert.ok(md.indexOf(NARRATIVE_START) < md.indexOf(NARRATIVE_END));
  assert.match(render(first, null), /First digest/);
});
