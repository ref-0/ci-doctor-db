import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { open } from '../db.ts';
import { cohortGaps, dueRefreshes, findGapRepos, planNight, predictSize, quotas, TARGET, type GitHub } from '../queue.ts';

// A repo with one measured report on `date`, scored unless `score` is null.
function add(db: DatabaseSync, repo: string, date: string, { size = 'large', language = 'TypeScript', score = 70 as number | null } = {}) {
  const id = `${repo}/${date}`;
  db.prepare(`INSERT INTO reports (id, repo, date, seq, path, sha256, score, size, language) VALUES (?, ?, ?, 0, ?, '', ?, ?, ?)`).run(
    id, repo, date, `${repo.replace('/', '__')}/${date}.json`, score, size, language,
  );
  db.prepare(`INSERT INTO checks (repo, at, reason, scored, report) VALUES (?, ?, 'import', ?, ?)`).run(repo, date, score === null ? 0 : 1, id);
  db.prepare(
    `INSERT INTO repos (repo, first_seen, last_checked, times_checked, latest_report) VALUES (?, ?, ?, 1, ?) ON CONFLICT (repo) DO UPDATE SET last_checked = excluded.last_checked, latest_report = excluded.latest_report`,
  ).run(repo, date, date, id);
}

test('refreshes are due 7 days after the last report, adopters 2, adopters first and then the longest overdue', () => {
  const db = open(':memory:');
  add(db, 'a/fresh', '2026-11-15');
  add(db, 'a/week', '2026-11-12');
  add(db, 'a/old', '2026-11-01');
  add(db, 'a/adopter', '2026-11-17');
  db.prepare(`INSERT INTO adoption VALUES ('a/adopter', 'marker', '2026-11-10', 'https://example.com')`).run();

  const due = dueRefreshes(db, '2026-11-19');

  assert.deepEqual(due.map((e) => [e.repo, e.reason]), [['a/adopter', 'adoption'], ['a/old', 'refresh'], ['a/week', 'refresh']]);
  assert.match(due[1]!.why, /last report 2026-11-01, 18 days ago/);
});

test('a failed check counts as an attempt, so a failing repo waits its 7 days again', () => {
  const db = open(':memory:');
  add(db, 'a/flaky', '2026-11-01');
  db.prepare(`INSERT INTO checks (repo, at, reason, scored, report, error) VALUES ('a/flaky', '2026-11-15T02:10:00.000Z', 'refresh', 0, NULL, 'HTTP 502')`).run();

  assert.deepEqual(dueRefreshes(db, '2026-11-19'), []);
  assert.match(dueRefreshes(db, '2026-11-22')[0]!.why, /last check failed 2026-11-15/);
});

test('gaps are target cohorts under 15 scored repos, furthest under first; unscored repos do not count', () => {
  const db = open(':memory:');
  for (let i = 0; i < TARGET; i++) add(db, `ts/large${i}`, '2026-11-18');
  for (let i = 0; i < 10; i++) add(db, `rs/large${i}`, '2026-11-18', { language: 'Rust' });
  add(db, 'rs/unscored', '2026-11-18', { language: 'Rust', score: null });

  const gaps = cohortGaps(db);

  assert.equal(gaps.find((g) => g.size === 'large' && g.language === 'TypeScript'), undefined);
  assert.deepEqual(gaps.find((g) => g.size === 'large' && g.language === 'Rust'), { size: 'large', language: 'Rust', n: 10, under: 5 });
  assert.equal(gaps[0]!.under, TARGET);
  assert.equal(gaps.at(-1)!.under, 5);
});

test('quotas share the slots by how far each cohort is under, none past its gap', () => {
  const gaps = [
    { size: 'large', language: 'Rust', n: 0, under: 15 },
    { size: 'medium', language: 'Go', n: 10, under: 5 },
    { size: 'small', language: 'C', n: 13, under: 2 },
  ];

  assert.deepEqual(Object.fromEntries(quotas(gaps, 11)), { 'large × Rust': 8, 'medium × Go': 2, 'small × C': 1 });
  assert.deepEqual(Object.fromEntries(quotas(gaps, 100)), { 'large × Rust': 15, 'medium × Go': 5, 'small × C': 2 });
  assert.deepEqual(Object.fromEntries(quotas(gaps, 1)), { 'large × Rust': 1 });
  assert.equal([...quotas(gaps, 11).values()].reduce((a, b) => a + b), 11);
  assert.equal(quotas(gaps, 0).size, 0);
});

test('size is predicted as the scorer takes it, the larger of code and traffic', () => {
  assert.equal(predictSize(5_000, 4), 'tiny');
  assert.equal(predictSize(50_000, 4), 'small');
  assert.equal(predictSize(50_000, 300), 'large');
  assert.equal(predictSize(2_000_000, 0), 'large');
});

type FakeRepo = { prs: number; fork?: boolean; archived?: boolean; language?: string; bytes?: number; runs?: number; id?: number; page?: number[] };

// Repos' ids are their order here unless given; `page` lists the search pages a repo comes back on (default [1]).
function fakeGitHub(repos: Record<string, FakeRepo>, ids: Record<string, number> = {}) {
  const asked: string[] = [];
  const idOf = (repo: string) => repos[repo]?.id ?? Object.keys(repos).indexOf(repo) + 1;
  const gh: GitHub = {
    searchRepos(language, _since, page) {
      asked.push(`search ${language} ${page}`);
      return Object.entries(repos)
        .filter(([, r]) => (r.language ?? 'Rust') === language && (r.page ?? [1]).includes(page))
        .map(([repo, r]) => ({ id: idOf(repo), repo, fork: !!r.fork, archived: !!r.archived, private: false, language: r.language ?? 'Rust', bytes: r.bytes ?? 30 * 300_000, prs: r.prs }));
    },
    prRuns: (repo) => (asked.push(`runs ${repo}`), repos[repo]!.runs ?? 50),
    repoIds: (names) => (asked.push(`ids ${names.join(',')}`), new Map(names.filter((n) => ids[n]).map((n) => [n, ids[n]!]))),
  };
  return { gh, asked, idOf };
}

test('gap repos come busiest first, skipping forks, archived, tracked and repos without PR runs', async () => {
  const { gh, idOf } = fakeGitHub({
    'x/busiest': { prs: 9, fork: true },
    'x/archived': { prs: 8, archived: true },
    'x/tracked': { prs: 7 },
    'x/no-runs': { prs: 6, runs: 2 },
    'x/good': { prs: 5 },
    'x/also': { prs: 4 },
    'x/third': { prs: 3 },
  });

  const found = await findGapRepos(gh, new Map([['medium × Rust', 2]]), new Set([idOf('x/tracked')]), '2026-11-19');

  assert.deepEqual(found.map((e) => e.repo), ['x/good', 'x/also']);
  assert.equal(found[0]!.reason, 'gap');
  assert.equal(found[0]!.cohort, 'medium × Rust');
});

test('a candidate predicted into a full or other cohort is passed over', async () => {
  const { gh, asked } = fakeGitHub({
    'x/huge': { prs: 9, bytes: 30 * 5_000_000 },
    'x/mid': { prs: 5 },
    'x/next': { prs: 4 },
  });

  const found = await findGapRepos(gh, new Map([['medium × Rust', 1]]), new Set(), '2026-11-19');

  assert.deepEqual(found.map((e) => e.repo), ['x/mid']);
  // Runs are read only for a repo whose cohort has room, and not once the quota is filled.
  assert.deepEqual(asked, ['search Rust 1', 'runs x/mid']);
});

test('the night is refreshes first, then gaps in what is left of the slots', async () => {
  const db = open(':memory:');
  for (let i = 0; i < 3; i++) add(db, `old/r${i}`, '2026-11-01', { language: 'Rust' });
  // Every cohort but these is just as far under, so the two slots left go to the first in the gaps' order.
  const { gh } = fakeGitHub({
    'new/small': { prs: 5, language: 'TypeScript', bytes: 30 * 50_000 },
    'new/medium': { prs: 4, language: 'TypeScript', bytes: 30 * 300_000 },
    'old/r0': { prs: 3, language: 'TypeScript', bytes: 30 * 50_000 },
  });

  const plan = await planNight(db, { today: '2026-11-19', slots: 5, gh });

  assert.deepEqual(Object.fromEntries(plan.quotas), { 'small × TypeScript': 1, 'medium × TypeScript': 1 });
  assert.deepEqual(plan.queue.map((e) => [e.reason, e.repo]), [
    ['refresh', 'old/r0'], ['refresh', 'old/r1'], ['refresh', 'old/r2'], ['gap', 'new/small'], ['gap', 'new/medium'],
  ]);

  const tight = await planNight(db, { today: '2026-11-19', slots: 2, gh });
  assert.deepEqual(tight.queue.map((e) => e.reason), ['refresh', 'refresh']);
  assert.equal(tight.quotas.size, 0);
});

test('discovery asks the quota guard before each core call, and stops when it says so', async () => {
  const { gh, asked } = fakeGitHub({ 'x/a': { prs: 5 }, 'x/b': { prs: 4 }, 'x/c': { prs: 3 } });
  let allowed = 1;

  const found = await findGapRepos(gh, new Map([['medium × Rust', 3]]), new Set(), '2026-11-19', () => {}, async () => allowed-- > 0);

  assert.deepEqual(found.map((e) => e.repo), ['x/a']);
  assert.deepEqual(asked, ['search Rust 1', 'runs x/a']);
});

test('a repo on two search pages takes one slot', async () => {
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`x/p${i}`, { prs: 1, page: [1], runs: 0 }]));
  const { gh } = fakeGitHub({ ...many, 'x/twice': { prs: 9, page: [1, 2] }, 'x/other': { prs: 2, page: [2] } });

  const found = await findGapRepos(gh, new Map([['medium × Rust', 2]]), new Set(), '2026-11-19');

  assert.deepEqual(found.map((e) => e.repo), ['x/twice', 'x/other']);
});

test('a renamed tracked repo is known by its id and not taken again, and ids are stored', async () => {
  const db = open(':memory:');
  add(db, 'old-owner/tool', '2026-11-18', { language: 'Rust', size: 'medium' });
  const { gh, asked } = fakeGitHub({ 'new-owner/tool': { prs: 9, id: 77 }, 'x/fresh': { prs: 5, id: 78 } }, { 'old-owner/tool': 77 });

  const plan = await planNight(db, { today: '2026-11-19', slots: 50, gh });

  assert.ok(!plan.queue.some((e) => e.repo === 'new-owner/tool'));
  assert.ok(plan.queue.some((e) => e.repo === 'x/fresh' && e.githubId === 78));
  assert.equal(db.prepare(`SELECT github_id FROM repos WHERE repo = 'old-owner/tool'`).get()!.github_id, 77);
  // Known ids aren't looked up again.
  await planNight(db, { today: '2026-11-19', slots: 50, gh });
  assert.equal(asked.filter((a) => a.startsWith('ids')).length, 1);
});

test("each cohort has its own screening budget: one cohort's failures leave another's chances", async () => {
  // Eight busy medium repos with no PR runs come first, then a small one that qualifies.
  const failing = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`x/m${i}`, { prs: 20 + i, runs: 0 }]));
  const { gh } = fakeGitHub({ ...failing, 'x/small': { prs: 5, bytes: 30 * 50_000 } });

  const found = await findGapRepos(gh, new Map([['medium × Rust', 1], ['small × Rust', 1]]), new Set(), '2026-11-19');

  assert.deepEqual(found.map((e) => e.repo), ['x/small']);
});
