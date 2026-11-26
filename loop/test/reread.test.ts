import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { open } from '../db.ts';
import { importOne, importReports, refreshRepos } from '../import.ts';
import { KEEP, CHECK_P90, reportText, runWeek, type CheckResult, type Clock } from '../measure.ts';
import { detectionOf, dueReports, recordReading, rereadDue, rereadLine, verdictChanges, type Reread, type RereadDeps } from '../reread.ts';
import type { Quota } from '../github.ts';

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'vitejs__vite', '2026-11-19.json'), 'utf8'));
const SCRATCH = process.env.LOOP_TEST_DIR ?? join(homedir(), '.cache', 'ci-loop-measure');
const T0 = Date.parse('2026-11-29T09:00:00Z');
const STOP = Date.parse('2026-11-29T13:00:00Z');
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);

const fakeClock = (start = T0): Clock => {
  let t = start;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
};
const plenty = (): Quota => ({ remaining: 5000, limit: 5000, reset: Math.floor(STOP / 1000) });

// A made-up repo's report, as the fixture's with its own name, practices and hints.
const report = (repo: string, date: string, practices: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  ...FIXTURE, repo, date, read: { calls: 66 }, ...extra, practices: { ...FIXTURE.practices, ...practices },
});

// A reports/ with these reports, imported into a fresh loop.db.
function setup(reports: Record<string, unknown>[]) {
  mkdirSync(SCRATCH, { recursive: true });
  const reportsDir = mkdtempSync(join(SCRATCH, 'reread-'));
  for (const r of reports) {
    const dir = String(r.repo).replace('/', '__');
    mkdirSync(join(reportsDir, dir), { recursive: true });
    writeFileSync(join(reportsDir, dir, `${r.date}.json`), reportText(r));
  }
  const db = open(':memory:');
  importReports(db, reportsDir);
  return { db, reportsDir, done: () => rmSync(reportsDir, { recursive: true, force: true }) };
}

// A scorer that reads every repo's practices as `now`, and remembers what it was asked.
function fakeScorer(now: Record<string, unknown>, fail: string[] = []) {
  const asked: string[] = [];
  const reread: Reread = async (file) => {
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    asked.push(stored.repo);
    if (fail.includes(stored.repo)) return { error: `GitHub answered 502 for repos/${stored.repo}` } as CheckResult;
    return { report: { ...stored, practices: { ...stored.practices, ...now }, practicesDate: '2026-11-29' } };
  };
  return { asked, reread };
}

const deps = (db: RereadDeps['db'], reportsDir: string, reread: Reread, extra: Partial<RereadDeps> = {}): RereadDeps => ({
  db, reportsDir, detection: NEW, clock: fakeClock(), stopAt: STOP, quota: plenty, token: () => 't', reread, importOne, log: () => {}, ...extra,
});

test("the detection's sha256 follows practices.ts and the code it imports, not its type imports or other files", () => {
  mkdirSync(SCRATCH, { recursive: true });
  const src = mkdtempSync(join(SCRATCH, 'scorer-'));
  const put = (name: string, text: string) => writeFileSync(join(src, name), text);
  put('practices.ts', "import { parse } from './yaml.ts';\nimport type { Source } from './source.ts';\nexport const p = 1;\n");
  put('yaml.ts', "import {\n  vcpus,\n} from './runners.ts';\nexport const parse = 1;\n");
  put('runners.ts', 'export const vcpus = 1;\n');
  put('source.ts', 'export type Source = 1;\n');
  put('score.ts', 'export const s = 1;\n');
  const first = detectionOf(src);

  put('source.ts', 'export type Source = 2;\n');
  put('score.ts', 'export const s = 2;\n');
  assert.equal(detectionOf(src), first);

  put('runners.ts', 'export const vcpus = 2;\n');
  const second = detectionOf(src);
  assert.notEqual(second, first);
  put('practices.ts', "import { parse } from './yaml.ts';\nimport type { Source } from './source.ts';\nexport const p = 2;\n");
  assert.notEqual(detectionOf(src), second);
  assert.match(first, /^[0-9a-f]{64}$/);
  rmSync(src, { recursive: true, force: true });
});

test('verdict changes are the practices whose value differs, never the workflow count, hints, unknowns or agent files', () => {
  const was = { workflows: 3, remoteCache: false, affected: false, depBotsBatched: true, hints: [{ practice: 'remoteCache' }], unknown: ['a'], agentsMd: ['AGENTS.md'] };
  const now = { workflows: 4, remoteCache: true, affected: true, depBotsBatched: null, hints: [], unknown: [], where: { remoteCache: 'ci.yml' }, agentsMd: [], mergeQueue: false };

  assert.deepEqual(verdictChanges(was, now), [
    { practice: 'remoteCache', was: false, now: true },
    { practice: 'affected', was: false, now: true },
    { practice: 'depBotsBatched', was: true, now: null },
    { practice: 'mergeQueue', was: null, now: false },
  ]);
  assert.deepEqual(verdictChanges(was, was), []);
});

test('a re-read writes the report back in place, as the measure writes it, and its row, practice columns and hints follow', async () => {
  const stored = report('pip/garden', '2026-11-22', { remoteCache: false, affected: false });
  const { db, reportsDir, done } = setup([stored, report('mo/kiln', '2026-11-22')]);
  const hints = [{ practice: 'affected', path: 'package.json', kind: 'script' }];
  const { asked, reread } = fakeScorer({ remoteCache: true, affected: true, hints });
  const lines: string[] = [];

  const r = await rereadDue(deps(db, reportsDir, reread, { log: (s) => lines.push(s) }));

  assert.deepEqual(asked, ['mo/kiln', 'pip/garden']);
  assert.deepEqual(r, { due: 2, read: 2, changed: 2, failed: 0, left: 0, calls: 0, stopped: 'every due report was read' });
  const file = join(reportsDir, 'pip__garden', '2026-11-22.json');
  const text = readFileSync(file, 'utf8');
  const now = JSON.parse(text);
  assert.equal(text, reportText(now));
  assert.equal(now.practices.remoteCache, true);
  assert.equal(now.practicesDate, '2026-11-29');
  assert.equal(now.score, stored.score);

  const row = db.prepare(`SELECT remote_cache, affected, sha256 FROM reports WHERE id = 'pip/garden/2026-11-22'`).get()!;
  assert.deepEqual([row.remote_cache, row.affected], [1, 1]);
  assert.deepEqual(db.prepare(`SELECT practice, path, kind FROM hints WHERE report = 'pip/garden/2026-11-22'`).all().map((h) => ({ ...h })), hints);
  assert.deepEqual({ ...db.prepare(`SELECT detection, how, changed FROM readings WHERE report = 'pip/garden/2026-11-22'`).get() }, { detection: NEW, how: 'reread', changed: 2 });
  assert.ok(lines.includes('  changed pip/garden remoteCache: false -> true'));
  assert.ok(lines.includes('  changed pip/garden affected: false -> true'));

  // A later import of the same files changes nothing: the row is the file's already.
  assert.equal(importReports(db, reportsDir).changes, 0);
  done();
});

test('a second run right after the first reads nothing and spends no call; a new detection makes every older reading due', async () => {
  const { db, reportsDir, done } = setup([report('pip/garden', '2026-11-22'), report('mo/kiln', '2026-11-22')]);
  const first = fakeScorer({ remoteCache: true });
  await rereadDue(deps(db, reportsDir, first.reread));
  let quotaReads = 0;
  const second = fakeScorer({ remoteCache: true });

  const again = await rereadDue(deps(db, reportsDir, second.reread, { quota: () => (quotaReads++, plenty()) }));

  assert.deepEqual(second.asked, []);
  assert.equal(quotaReads, 0);
  assert.deepEqual([again.due, again.read, again.left], [0, 0, 0]);

  const later = fakeScorer({ remoteCache: true });
  const r = await rereadDue(deps(db, reportsDir, later.reread, { detection: 'c'.repeat(64) }));
  assert.deepEqual(later.asked, ['mo/kiln', 'pip/garden']);
  assert.equal(r.changed, 0);

  // --all reads every one, whatever readings says.
  assert.equal(dueReports(db, 'c'.repeat(64)).length, 0);
  assert.equal(dueReports(db, 'c'.repeat(64), true).length, 2);
  done();
});

test("a report the measure run just measured isn't due, and only a repo's latest report is", async () => {
  const { db, reportsDir, done } = setup([report('pip/garden', '2026-11-15'), report('mo/kiln', '2026-11-22')]);
  const today = new Date(T0).toISOString().slice(0, 10);
  const clock = fakeClock();

  await runWeek([{ repo: 'pip/garden', reason: 'gap', why: 'test' }], {
    db, reportsDir, clock, stopAt: STOP, quota: plenty, token: () => 't', log: () => {},
    check: async (repo) => ({ report: report(repo, today) }),
    changedSince: () => ({ changed: true, calls: 1 }),
    importOne, refreshRepos,
    readBy: (id, at) => recordReading(db, id, NEW, at, 'measure'),
  });

  assert.deepEqual(dueReports(db, NEW).map((d) => d.id), ['mo/kiln/2026-11-22']);
  assert.equal(db.prepare(`SELECT how FROM readings WHERE report = ?`).get(`pip/garden/${today}`)!.how, 'measure');
  done();
});

test("a re-read that fails leaves the report untouched, is counted, and is due again; a submitted-only repo isn't due", async () => {
  const submitted = report('ana/loom', '2026-11-22', {}, { submitted: { by: 'ana', at: '2026-11-22T10:00:00Z' } });
  const { db, reportsDir, done } = setup([report('pip/garden', '2026-11-22'), report('mo/kiln', '2026-11-22'), submitted]);
  const file = join(reportsDir, 'pip__garden', '2026-11-22.json');
  const before = readFileSync(file, 'utf8');
  const lines: string[] = [];
  const { asked, reread } = fakeScorer({ remoteCache: true }, ['pip/garden']);

  const r = await rereadDue(deps(db, reportsDir, reread, { log: (s) => lines.push(s) }));

  assert.deepEqual(asked, ['mo/kiln', 'pip/garden']);
  assert.deepEqual([r.read, r.changed, r.failed, r.left], [1, 1, 1, 0]);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.ok(lines.some((l) => /reread pip\/garden\/2026-11-22: failed, left as it was \(GitHub answered 502/.test(l)));
  assert.deepEqual(dueReports(db, NEW).map((d) => d.id), ['pip/garden/2026-11-22']);
  assert.match(rereadLine(r), /^reread: 1 of 2 due reports' practices read again \(1 with a verdict changed, 1 failed\); 0 left for the next run/);
  done();
});

test('re-reads stop at the stop time and wait on the quota, leaving the rest for the next run', async () => {
  const repos = Array.from({ length: 6 }, (_, i) => report(`pip/r${i}`, '2026-11-22'));
  const { db, reportsDir, done } = setup(repos);
  const clock = fakeClock(STOP - 25 * 60_000);
  let remaining = KEEP + CHECK_P90 + 39;
  // Each re-read takes 10 minutes and spends 40 calls, so the second waits for a reset after the stop time.
  const quota = (): Quota => ({ remaining, limit: 5000, reset: Math.floor((STOP + 3_600_000) / 1000) });
  const reread: Reread = async (file) => ((remaining -= 40), await clock.sleep(10 * 60_000), fakeScorer({}).reread(file, 't', 1));

  const r = await rereadDue(deps(db, reportsDir, reread, { clock, quota }));

  assert.deepEqual([r.read, r.left, r.calls], [1, 5, 40]);
  assert.match(r.stopped, /low until after the stop time/);

  const max = await rereadDue(deps(db, reportsDir, fakeScorer({}).reread, { max: 2 }));
  assert.deepEqual([max.due, max.read, max.left, max.stopped], [5, 2, 3, 'reached --max 2']);
  done();
});

test('the command exits at once while a measure run holds the lock', () => {
  mkdirSync(SCRATCH, { recursive: true });
  const lock = join(SCRATCH, `reread-lock-${process.pid}.lock`);
  writeFileSync(lock, `${process.pid}\n`);

  const r = spawnSync('node', [join(import.meta.dirname, '..', 'reread.ts'), '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, LOOP_LOCK: lock },
    timeout: 30_000,
  });

  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`reread: couldn't start: a measure run or another re-read \\(pid ${process.pid}\\) holds the lock`));
  assert.equal(readFileSync(lock, 'utf8'), `${process.pid}\n`);
  rmSync(lock, { force: true });
});
