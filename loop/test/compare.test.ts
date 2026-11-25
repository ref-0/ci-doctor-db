import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { open } from '../db.ts';
import { importReports } from '../import.ts';
import { compare, newReports, noDigest, pct, trustedLabels, type Digest, type Labels } from '../compare.ts';
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
  db.prepare(`INSERT INTO repos (repo, first_seen, last_checked, times_checked, latest_report) VALUES (?, ?, ?, 1, ?)`).run(repo, src.date as string, src.date as string, row.id);
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

test("with no report newer than the previous digest, whatever its date, there's no digest; one new report makes one", () => {
  const db = fixtureDb();
  const week = { date: '2026-11-29', made_at: '2026-11-29T22:00:00.000Z' };

  assert.equal(noDigest(db, null), null, 'a first digest is always written');
  assert.equal(noDigest(db, week), 'no digest: no report is newer than the 2026-11-29 digest, made 2026-11-29T22:00:00.000Z');
  // The last reports are from 25 Nov: a digest made that evening, or four days later, has nothing newer either way.
  assert.match(noDigest(db, { date: '2026-11-25', made_at: '2026-11-25T22:00:00.000Z' }) ?? '', /^no digest: no report is newer than the 2026-11-25 digest/);
  db.prepare(`INSERT INTO checks (repo, at, reason, scored, report) VALUES ('vitejs/vite', '2026-12-06T10:00:00.000Z', 'refresh', 1, 'vitejs/vite/2026-11-19')`).run();

  assert.equal(noDigest(db, week), null);
  assert.equal(newReports(db, week.made_at), 1);
  const d = compare(db, { date: '2026-12-06', labels: NO_LABELS, previous: week as never, now: Date.parse('2026-12-06T22:00:00Z') });
  assert.deepEqual(d.new_reports, { since: '2026-11-29T22:00:00.000Z', n: 1 });
  assert.equal(d.made_at, '2026-12-06T22:00:00.000Z');
  assert.equal(d.probe.checks.n, 1);
});

test('the hints section counts hints by practice and kind over latest reports, most first, with up to 3 example repos', () => {
  const db = fixtureDb();
  for (let i = 0; i < 4; i++) clone(db, 'vitejs/vite', `pip/site-${i}`, {});
  const hint = db.prepare(`INSERT INTO hints (report, practice, path, kind) VALUES (?, ?, ?, ?)`);
  const latest = (repo: string) => (db.prepare(`SELECT latest_report FROM repos WHERE repo = ?`).get(repo) as { latest_report: string }).latest_report;
  for (const repo of ['pip/site-0', 'pip/site-1', 'pip/site-2', 'pip/site-3']) hint.run(latest(repo), 'remoteCache', '.github/workflows/ci.yml', 'unknown-action');
  hint.run(latest('pip/site-3'), 'remoteCache', '.github/workflows/release.yml', 'unknown-action');
  hint.run(latest('astral-sh/ruff'), 'affected', 'Cargo.toml|`x`', 'script');
  // Not a latest report: left out.
  hint.run('vitejs/vite/2026-11-18', 'affected', 'package.json', 'script');

  const d = run(db);
  const md = render(d, null);

  assert.deepEqual(d.hints.rows, [
    { practice: 'remoteCache', kind: 'unknown-action', hints: 5, repos: 4, examples: [{ repo: 'pip/site-3', path: '.github/workflows/ci.yml' }, { repo: 'pip/site-0', path: '.github/workflows/ci.yml' }, { repo: 'pip/site-1', path: '.github/workflows/ci.yml' }] },
    { practice: 'affected', kind: 'script', hints: 1, repos: 1, examples: [{ repo: 'astral-sh/ruff', path: 'Cargo.toml|`x`' }] },
  ]);
  assert.match(md, /## Practices the scorer did not recognise\n\nHints in each repo's latest report: 6 places in 5 repos/);
  assert.match(md, /\| remoteCache \| unknown-action \| 5 \| 4 \| pip\/site-3 \(`\.github\/workflows\/ci\.yml`\), pip\/site-0/);
  assert.match(md, /\| affected \| script \| 1 \| 1 \| astral-sh\/ruff \(`Cargo\.toml x `\) \|/);
  assert.ok(md.indexOf('## Practices the scorer did not recognise') > md.indexOf('## Health of the probe'));
});

test('with no hints, or only reports from before the field, the hints section is left out', () => {
  const d = run(fixtureDb());

  assert.deepEqual(d.hints, { n: 0, repos: 0, rows: [] });
  assert.doesNotMatch(render(d, null), /did not recognise/);
});

test('compare.ts and digest.ts, with nothing newer than the previous digest, each print one `no digest:` line, write nothing and exit 0', () => {
  const scratch = process.env.LOOP_TEST_DIR ?? join(homedir(), '.cache', 'ci-loop-measure');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'digest-'));
  const dbFile = join(dir, 'loop.db');
  const db = open(dbFile);
  importReports(db, FIXTURES);
  importReports(db, LATER);
  db.close();
  const out = join(dir, 'digest');
  mkdirSync(out);
  writeFileSync(join(out, '2026-11-29.json'), JSON.stringify({ date: '2026-11-29', made_at: '2026-11-29T22:00:00.000Z' }));
  const script = (name: string) => spawnSync('node', [join(import.meta.dirname, '..', name), '--db', dbFile, '--out', out, '--date', '2026-12-06'], { encoding: 'utf8', timeout: 30_000 });

  for (const name of ['compare.ts', 'digest.ts']) {
    const r = script(name);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'no digest: no report is newer than the 2026-11-29 digest, made 2026-11-29T22:00:00.000Z\n');
  }
  assert.ok(!existsSync(join(out, '2026-12-06.json')) && !existsSync(join(out, '2026-12-06.md')));

  // A previous digest made before ruff's 25 Nov report: both write, and digest.ts prints the .md's path.
  rmSync(join(out, '2026-11-29.json'));
  writeFileSync(join(out, '2026-11-22.json'), JSON.stringify({ ...run(fixtureDb({ later: false })), date: '2026-11-22', made_at: '2026-11-22T22:00:00.000Z' }));
  assert.equal(script('compare.ts').status, 0);
  const md = script('digest.ts');
  assert.equal(md.stdout, `${join(out, '2026-12-06.md')}\n`);
  assert.match(readFileSync(join(out, '2026-12-06.md'), 'utf8'), /1 reports new since the 2026-11-22 digest/);
  rmSync(dir, { recursive: true, force: true });
});
