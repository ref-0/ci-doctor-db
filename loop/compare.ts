// The loop's compare step: cohorts, movers, noise, the probe's and the score's health, practice effects and adoption,
// computed from loop.db with no model and no network, into digest/YYYY-MM-DD.json. Everything "since" is since the
// previous digest was made, whatever its date. With no report newer than it, there's nothing to learn: it writes
// nothing, prints one line starting `no digest:` and exits 0, as digest.ts does.
// The trusted labels for separation come from the repo's own label files, as calibrate.py reads them.
// Usage: node loop/compare.ts [--db <file>] [--out <dir>] [--date YYYY-MM-DD] [--labels <research.csv>] [--sets <sets.py>]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_DB, open } from './db.ts';

const ROOT = join(import.meta.dirname, '..');
export const DEFAULT_OUT = process.env.DIGEST_DIR ?? join(ROOT, 'digest');
export const DEFAULT_LABELS = join(ROOT, 'inbox', 'research.csv');
export const DEFAULT_SETS = join(ROOT, 'calibration', 'sets.py');

export const MIN_COHORT = 5; // cohorts and traits within them
export const MIN_EFFECT_COHORT = 10; // cohorts that get practice effects
export const MIN_EFFECT_SIDE = 5; // each side of an effect, to rank among the top ones
export const MIN_NOISE = 20; // noise samples before the noise sets the movers threshold
export const PLACEHOLDER_THRESHOLD = 0.25;

// Practices stored as 0/1. `workflows` is a count and the three named ones are text: they're traits, not effects.
export const FLAGS = [
  'cancel_in_progress', 'path_filters', 'affected', 'draft_skip', 'merge_queue', 'scheduled', 'dep_cache',
  'remote_cache', 'compiler_cache', 'frozen_install', 'shards_configured', 'timeouts', 'fast_lint', 'eslint',
  'test_results', 'dep_bots_batched', 'agent_rules', 'pre_commit',
] as const;
export const NAMED_TRAITS = ['package_manager', 'test_runner', 'task_runner'] as const;
const PRACTICES = ['workflows', ...FLAGS, ...NAMED_TRAITS] as const;

// Runner providers the scorer names from job labels; anything else is a raw label it didn't recognise.
export const KNOWN_RUNNERS = new Set([
  'Blacksmith', 'Depot', 'Namespace', 'BuildJet', 'WarpBuild', 'Ubicloud', 'RunsOn', 'self-hosted', 'GitHub larger', 'GitHub-hosted',
]);

type Row = Record<string, any>;
export type Spread = { p10: number | null; p50: number | null; p90: number | null };
export type Labels = Map<string, 'fast' | 'slow'>;

// Nearest rank, as db.ts's cohorts query takes it.
export function pct(xs: number[], p: number): number | null {
  const s = xs.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.max(1, Math.ceil((p * s.length) / 100)) - 1];
}

const round = (x: number | null, d = 1) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
const spread = (xs: number[], d = 1): Spread => ({ p10: round(pct(xs, 10), d), p50: round(pct(xs, 50), d), p90: round(pct(xs, 90), d) });
const values = (rows: Row[], col: string) => rows.map((r) => r[col]).filter((v) => typeof v === 'number');
const stackOf = (r: Row) => JSON.parse(r.stack ?? '{}');
const mainRunner = (r: Row): string | null => stackOf(r).runners?.[0]?.[0] ?? null;

function count<T>(xs: T[], key: (x: T) => string): { value: string; n: number }[] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
}

// ---------- labels: calibrate.py's trusted set ----------

// RFC 4180 rows: quoted fields may hold commas, quotes and newlines.
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(field), (field = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field), rows.push(row), (row = []), (field = '');
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);

  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// As calibration/calib.py's trust(): research.csv's fast and slow labels, less the well-run slice and every repo
// sets.py distrusts or reports apart. sets.py is the one list; its quoted owner/name strings are read from it.
export function trustedLabels(researchCsv: string, setsPy: string): Labels {
  const excluded = new Set([...setsPy.matchAll(/'([\w.-]+\/[\w.-]+)'/g)].map((m) => m[1].toLowerCase()));
  const labels: Labels = new Map();
  for (const r of parseCsv(researchCsv)) {
    const repo = r.repo?.toLowerCase();
    if (!repo || (r.expected !== 'fast' && r.expected !== 'slow')) continue;
    if (r.slice === 'well-run' || excluded.has(repo)) continue;
    labels.set(repo, r.expected);
  }
  return labels;
}

// ---------- the parts ----------

function latestScored(db: DatabaseSync): Row[] {
  return db
    .prepare(`SELECT r.* FROM repos p JOIN reports r ON r.id = p.latest_report WHERE r.score IS NOT NULL ORDER BY r.repo`)
    .all() as Row[];
}

const metrics = (rows: Row[]) => ({
  wait_p50: spread(values(rows, 'wait_p50')),
  score: spread(values(rows, 'score'), 0),
  job_minutes_per_merged_pr: spread(values(rows, 'job_minutes_per_merged_pr')),
});

// Each repo's traits, as `name` or `name=value`, for grouping within a cohort.
function traits(r: Row): string[] {
  const out: string[] = FLAGS.filter((f) => r[f] === 1).map(String);
  for (const t of NAMED_TRAITS) if (r[t]) out.push(`${t}=${r[t]}`);
  const runner = mainRunner(r);
  if (runner) out.push(`runner=${runner}`);
  return out;
}

export function cohorts(scored: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const r of scored) {
    const k = `${r.size}\u0000${r.language}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  const rows = [];
  let skipped = 0;
  let skippedRepos = 0;
  let skippedTraits = 0;
  for (const [k, members] of groups) {
    if (members.length < MIN_COHORT) {
      skipped++, (skippedRepos += members.length);
      continue;
    }
    const [size, language] = k.split('\u0000');
    const byTrait = new Map<string, Row[]>();
    for (const r of members) for (const t of traits(r)) byTrait.set(t, [...(byTrait.get(t) ?? []), r]);
    const traitRows = [];
    for (const [trait, withIt] of [...byTrait].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
      if (withIt.length < MIN_COHORT) {
        skippedTraits++;
        continue;
      }
      traitRows.push({ trait, n: withIt.length, ...metrics(withIt) });
    }
    rows.push({ size, language, n: members.length, ...metrics(members), traits: traitRows });
  }

  rows.sort((a, b) => b.n - a.n || a.size.localeCompare(b.size) || a.language.localeCompare(b.language));
  return {
    min_n: MIN_COHORT,
    rows,
    skipped: { cohorts: skipped, repos: skippedRepos, traits: skippedTraits },
    note: `cohorts are size class × main language over each repo's latest scored report; ${skipped} cohorts (${skippedRepos} repos) under ${MIN_COHORT} skipped, and ${skippedTraits} traits under ${MIN_COHORT} within kept cohorts`,
  };
}

// A repo's last two measured reports (not rescores), oldest first.
function lastTwoMeasured(db: DatabaseSync): [Row, Row][] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT r.*, ROW_NUMBER() OVER (PARTITION BY repo ORDER BY date DESC) AS k FROM reports r WHERE seq = 0
       ) WHERE k <= 2 ORDER BY repo, date`,
    )
    .all() as Row[];
  const pairs: [Row, Row][] = [];
  for (let i = 0; i + 1 < rows.length; i++) if (rows[i].repo === rows[i + 1].repo) pairs.push([rows[i], rows[i + 1]]);
  return pairs;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// What differs between two reports of one repo, by kind. Runner job counts and package counts move every week,
// so the stack compares which ecosystems, languages and providers are present, not how much.
export function changes(a: Row, b: Row) {
  const practices: Record<string, [unknown, unknown]> = {};
  for (const p of PRACTICES) if (!same(a[p], b[p])) practices[p] = [a[p], b[p]];

  const sa = stackOf(a);
  const sb = stackOf(b);
  const stack: Record<string, [unknown, unknown]> = {};
  const langs = (s: Row) => (s.languages ?? []).filter(([, pct]: [string, number]) => pct >= 5).map(([n]: [string]) => n);
  const ecosystems = (s: Row) => Object.entries(s.packages ?? {}).filter(([, n]) => (n as number) > 0).map(([k]) => k).sort();
  if (!same(langs(sa), langs(sb))) stack.languages = [langs(sa), langs(sb)];
  if (!same(ecosystems(sa), ecosystems(sb))) stack.packages = [ecosystems(sa), ecosystems(sb)];
  if (!same([...(sa.agentFiles ?? [])].sort(), [...(sb.agentFiles ?? [])].sort())) stack.agentFiles = [sa.agentFiles, sb.agentFiles];

  const providers = (s: Row) => (s.runners ?? []).map(([p]: [string]) => p).sort();
  const runners: Record<string, [unknown, unknown]> = {};
  if (!same(providers(sa), providers(sb))) runners.providers = [providers(sa), providers(sb)];

  const window: Record<string, [unknown, unknown]> = {};
  for (const [k, col] of [['days', 'window_days'], ['runs', 'window_runs'], ['truncated', 'window_truncated']]) {
    if (!same(a[col], b[col])) window[k] = [a[col], b[col]];
  }

  return { practices, stack, runners, window };
}

const relative = (from: number, to: number) => (to - from) / from;

export function noiseAndMovers(db: DatabaseSync) {
  const pairs = lastTwoMeasured(db).filter(([a, b]) => a.wait_p50 > 0 && typeof b.wait_p50 === 'number');

  const steady = pairs.filter(([a, b]) => {
    const c = changes(a, b);
    return !Object.keys(c.practices).length && !Object.keys(c.stack).length && !Object.keys(c.runners).length;
  });
  const waitMoves = steady.map(([a, b]) => Math.abs(relative(a.wait_p50, b.wait_p50)));
  // Measured reports' own scores: one from before a recalibration keeps its older scale until it's rescored.
  const scoreMoves = steady.filter(([a, b]) => a.score !== null && b.score !== null).map(([a, b]) => Math.abs(b.score - a.score));
  const placeholder = steady.length < MIN_NOISE;
  const threshold = placeholder ? PLACEHOLDER_THRESHOLD : (pct(waitMoves, 90) as number);
  const noise = {
    n: steady.length,
    wait_p50_change: spread(waitMoves, 3),
    score_change: { n: scoreMoves.length, ...spread(scoreMoves, 0) },
    threshold: round(threshold, 3),
    placeholder,
    note: placeholder
      ? `${steady.length} repos with two measured reports and no change in practices or stack, under the ${MIN_NOISE} needed: the movers threshold is a fixed ${PLACEHOLDER_THRESHOLD * 100}%, a placeholder`
      : `the movers threshold is the p90 of |relative p50 change| over ${steady.length} unchanged repos`,
    repos: steady.map(([a, b]) => ({ repo: a.repo, from: a.date, to: b.date, change: round(relative(a.wait_p50, b.wait_p50), 3) })),
  };

  const movers = pairs
    .map(([a, b]) => ({ a, b, change: relative(a.wait_p50, b.wait_p50) }))
    .filter((m) => Math.abs(m.change) > threshold)
    .sort((x, y) => Math.abs(y.change) - Math.abs(x.change))
    .map(({ a, b, change }) => ({
      repo: a.repo,
      from: a.date,
      to: b.date,
      wait_p50: [round(a.wait_p50), round(b.wait_p50)],
      change: round(change, 3),
      score: [a.score, b.score],
      changed: changes(a, b),
    }));

  return {
    noise,
    movers: {
      pairs: pairs.length,
      threshold: round(threshold, 3),
      rows: movers,
      note: !pairs.length
        ? 'no repo has two measured reports yet: no history to compare'
        : `${movers.length} of ${pairs.length} repos with two measured reports moved more than ${round(threshold * 100, 0)}%`,
    },
  };
}

// The scorer's unscored reasons carry counts ("Only 3 PR pushes…"); group them without the numbers.
const reason = (s: string | null) => (s ?? 'no reason given').replace(/\d+(\.\d+)?/g, 'N');

export function probeHealth(db: DatabaseSync, scored: Row[], since: string | null) {
  const checks = db.prepare(`SELECT * FROM checks WHERE ? IS NULL OR at > ? ORDER BY at`).all(since, since) as Row[];
  const failed = checks.filter((c) => c.report === null);
  const unscored = checks.filter((c) => c.report !== null && !c.scored);

  const timed = (rows: Row[]) => {
    const read = rows.filter((r) => r.logs_read > 0);
    const parsed = rows.filter((r) => r.files_timed > 0);
    return { n: rows.length, logs_read: read.length, timed: parsed.length, share: rows.length ? round(parsed.length / rows.length, 3) : null };
  };
  const by = (key: (r: Row) => string) => {
    const groups = new Map<string, Row[]>();
    for (const r of scored) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
    return [...groups].map(([value, rows]) => ({ value, ...timed(rows) })).sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
  };

  const runnerLabels = new Map<string, number>();
  for (const r of scored) {
    for (const [p] of stackOf(r).runners ?? []) if (!KNOWN_RUNNERS.has(p)) runnerLabels.set(p, (runnerLabels.get(p) ?? 0) + 1);
  }
  const noRunner = scored.filter((r) => !r.test_runner);
  const calls = values(scored, 'api_calls');
  const days = values(scored, 'window_days');
  const bots = values(scored, 'bot_run_share');

  return {
    checks: {
      since,
      n: checks.length,
      failed: { n: failed.length, why: count(failed, (c) => reason(c.error)) },
      unscored: { n: unscored.length, why: count(unscored, (c) => reason(c.error)) },
    },
    test_timings: {
      ...timed(scored),
      by_test_runner: by((r) => r.test_runner ?? 'none detected'),
      by_language: by((r) => r.language ?? 'unknown'),
    },
    unrecognised: {
      runner_labels: [...runnerLabels].map(([label, repos]) => ({ label, repos })).sort((a, b) => b.repos - a.repos || a.label.localeCompare(b.label)),
      no_test_runner: { n: noRunner.length, by_language: count(noRunner, (r) => r.language ?? 'unknown') },
    },
    // GitHub's runs list stops at 1,000: a truncated window is a busy repo judged on fewer days.
    windows: {
      n: scored.length,
      truncated: scored.filter((r) => r.window_truncated === 1).length,
      under_3_days: days.filter((d) => d < 3).length,
      under_1_day: days.filter((d) => d < 1).length,
      days: spread(days),
    },
    bot_run_share: { n: bots.length, ...spread(bots, 3) },
    api_calls: { n: calls.length, p50: pct(calls, 50), p90: pct(calls, 90) },
  };
}

const bands = (xs: number[]) => ({
  at75: xs.filter((x) => x >= 75).length,
  from50to74: xs.filter((x) => x >= 50 && x < 75).length,
  under50: xs.filter((x) => x < 50).length,
});

export function scoreHealth(scored: Row[], labels: Labels, previous: Row | null) {
  const fast = scored.filter((r) => labels.get(r.repo.toLowerCase()) === 'fast');
  const slow = scored.filter((r) => labels.get(r.repo.toLowerCase()) === 'slow');
  const fastOk = fast.filter((r) => r.score >= 75);
  const slowOk = slow.filter((r) => r.score < 50);
  const misses = [
    ...fast.filter((r) => r.score < 75).map((r) => ({ repo: r.repo, label: 'fast', score: r.score, wait_p50: round(r.wait_p50) })),
    ...slow.filter((r) => r.score >= 50).map((r) => ({ repo: r.repo, label: 'slow', score: r.score, wait_p50: round(r.wait_p50) })),
  ];
  const scores = values(scored, 'score');
  const distribution = { n: scores.length, ...spread(scores, 0), bands: bands(scores) };

  return {
    separation: {
      fast: { n: fast.length, at75: fastOk.length, share: fast.length ? round(fastOk.length / fast.length, 3) : null },
      slow: { n: slow.length, under50: slowOk.length, share: slow.length ? round(slowOk.length / slow.length, 3) : null },
      misses,
      labels: labels.size,
      note: 'trusted labels as calibration/calib.py takes them: research.csv less the well-run slice and sets.py',
    },
    distribution,
    previous: previous?.score?.distribution ?? null,
  };
}

// Within each cohort of 10 or more, the p50 wait with each practice and without it.
export function practiceEffects(scored: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const r of scored) groups.set(`${r.size}\u0000${r.language}`, [...(groups.get(`${r.size}\u0000${r.language}`) ?? []), r]);

  const rows = [];
  for (const [k, members] of groups) {
    if (members.length < MIN_EFFECT_COHORT) continue;
    const [size, language] = k.split('\u0000');
    for (const f of FLAGS) {
      const withIt = values(members.filter((r) => r[f] === 1), 'wait_p50');
      const without = values(members.filter((r) => r[f] === 0), 'wait_p50');
      if (!withIt.length || !without.length) continue;
      const w = pct(withIt, 50) as number;
      const wo = pct(without, 50) as number;
      rows.push({
        size,
        language,
        cohort_n: members.length,
        practice: f,
        with: { n: withIt.length, wait_p50: round(w) },
        without: { n: without.length, wait_p50: round(wo) },
        ratio: wo > 0 ? round(w / wo, 2) : null,
        ranked: withIt.length >= MIN_EFFECT_SIDE && without.length >= MIN_EFFECT_SIDE,
      });
    }
  }

  // Strongest first: the larger |log ratio|, either way, among those with enough on both sides.
  const strength = (r: { ratio: number | null; ranked: boolean }) => (r.ranked && r.ratio ? Math.abs(Math.log(r.ratio)) : -1);
  rows.sort((a, b) => strength(b) - strength(a) || b.cohort_n - a.cohort_n);
  return {
    min_cohort: MIN_EFFECT_COHORT,
    min_side_to_rank: MIN_EFFECT_SIDE,
    kind: 'correlation',
    note: 'correlations across repos within a cohort, not causes',
    rows: rows.map((r) => ({ ...r, kind: 'correlation' })),
  };
}

// The scorer's hints over each repo's latest report: places that look like a practice in a form it doesn't recognise,
// counted by practice and kind, the most first, each with up to 3 example repos, those with the most hints first.
// What tops the list is the next detection to add.
export function hints(db: DatabaseSync) {
  const all = db
    .prepare(
      `SELECT h.practice, h.kind, h.path, r.repo FROM repos p JOIN reports r ON r.id = p.latest_report JOIN hints h ON h.report = r.id
        ORDER BY r.repo, h.path`,
    )
    .all() as { practice: string; kind: string; path: string; repo: string }[];

  const groups = new Map<string, typeof all>();
  for (const h of all) {
    const k = `${h.practice}\u0000${h.kind}`;
    groups.set(k, [...(groups.get(k) ?? []), h]);
  }
  const rows = [...groups.values()].map((hs) => {
    const byRepo = count(hs, (h) => h.repo);
    return {
      practice: hs[0]!.practice,
      kind: hs[0]!.kind,
      hints: hs.length,
      repos: byRepo.length,
      examples: byRepo.slice(0, 3).map(({ value }) => ({ repo: value, path: hs.find((h) => h.repo === value)!.path })),
    };
  });
  rows.sort((a, b) => b.hints - a.hints || b.repos - a.repos || a.practice.localeCompare(b.practice) || a.kind.localeCompare(b.kind));
  return { n: all.length, repos: new Set(all.map((h) => h.repo)).size, rows };
}

function adoption(db: DatabaseSync) {
  const rows = db.prepare(`SELECT * FROM adoption ORDER BY first_seen, repo`).all() as Row[];
  return { n: rows.length, rows, note: rows.length ? `${rows.length} adoption signals` : 'no adoption signals yet' };
}

// ---------- the digest ----------

// The newest digest dated before `date`, however long before.
export function previousDigest(dir: string, date: string): Row | null {
  if (!existsSync(dir)) return null;
  const earlier = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < date)
    .sort();
  return earlier.length ? JSON.parse(readFileSync(join(dir, earlier.at(-1)!), 'utf8')) : null;
}

// When the previous digest was made, which "since" in a digest means. One made before digests kept their time has only
// its date.
export const digestSince = (previous: Row | null): string | null => previous?.made_at ?? previous?.date ?? null;

// Reports measured or imported since `since`, by their checks' times: the measure run's are ISO times, an import's the
// report's date. A rescore isn't a check, so it isn't counted.
export function newReports(db: DatabaseSync, since: string | null): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM checks WHERE report IS NOT NULL AND (? IS NULL OR at > ?)`).get(since, since) as { n: number }).n;
}

// Why there's no digest this time, when there's a previous one and no report newer than it: the one line both scripts
// print, which the learn job tells from a digest's path.
export function noDigest(db: DatabaseSync, previous: Row | null): string | null {
  if (!previous || newReports(db, digestSince(previous)) > 0) return null;
  return `no digest: no report is newer than the ${previous.date} digest, made ${digestSince(previous)}`;
}

export function compare(db: DatabaseSync, opts: { date: string; labels: Labels; previous: Row | null; now?: number }) {
  const since = digestSince(opts.previous);
  const scored = latestScored(db);
  const totals = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM repos) AS repos, (SELECT COUNT(*) FROM reports) AS reports,
              (SELECT COUNT(*) FROM reports WHERE seq = 0) AS measured, (SELECT COUNT(*) FROM checks) AS checks`,
    )
    .get() as Row;
  const { noise, movers } = noiseAndMovers(db);

  return {
    date: opts.date,
    made_at: new Date(opts.now ?? Date.now()).toISOString(),
    previous: opts.previous?.date ?? null,
    new_reports: { since, n: newReports(db, since) },
    totals: { ...totals, scored: scored.length },
    cohorts: cohorts(scored),
    movers,
    noise,
    probe: probeHealth(db, scored, since),
    score: scoreHealth(scored, opts.labels, opts.previous),
    effects: practiceEffects(scored),
    hints: hints(db),
    adoption: adoption(db),
  };
}

export type Digest = ReturnType<typeof compare>;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

export const today = () => new Date().toLocaleDateString('en-CA');

if (import.meta.main) {
  const date = arg('--date') ?? today();
  const out = arg('--out') ?? DEFAULT_OUT;
  const db = open(arg('--db') ?? DEFAULT_DB);
  const labels = trustedLabels(readFileSync(arg('--labels') ?? DEFAULT_LABELS, 'utf8'), readFileSync(arg('--sets') ?? DEFAULT_SETS, 'utf8'));

  const previous = previousDigest(out, date);
  const none = noDigest(db, previous);
  if (none) {
    console.log(none);
    process.exit(0);
  }

  const digest = compare(db, { date, labels, previous });
  db.close();

  mkdirSync(out, { recursive: true });
  const file = join(out, `${date}.json`);
  writeFileSync(file, JSON.stringify(digest, null, 2) + '\n');
  console.log(`${file}: ${digest.totals.scored} scored repos, ${digest.cohorts.rows.length} cohorts, ${digest.movers.rows.length} movers, noise n ${digest.noise.n}`);
}
