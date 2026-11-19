// CI score: what a public repo's GitHub data says about its CI, scored 0–100, with what to fix first.
// Usage: node score.ts owner/repo [owner/repo ...] [--days 7] [--json]
// API calls go through `gh api` (the caller's token) and are cached for 24 h in ./cache; raw files come
// from raw.githubusercontent.com, which doesn't spend API quota. Reports land in ./reports.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const CACHE = join(HERE, 'cache');
const DAY = 24 * 3600e3;
const MAX_RUN_PAGES = 10;
const JOB_SAMPLE = 6;
const GUIDE = 'https://github.com/ref-0/ci-doctor/blob/main/docs/pages/';

// ---------- fetching ----------

let calls = 0;

const cached = (key: string, load: () => string): string => {
  const file = join(CACHE, createHash('sha1').update(key).digest('hex'));
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < DAY) return readFileSync(file, 'utf8');

  const text = load();
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, text);
  return text;
};

const apiText = (path: string): string =>
  cached(`api:${path}`, () => {
    const run = () => {
      calls++;
      return execFileSync('gh', ['api', '--allow-escape-sequences', path], {
        encoding: 'utf8',
        maxBuffer: 512 << 20,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    };
    try {
      return run();
    } catch (e) {
      if (/HTTP 404|HTTP 410|HTTP 403/.test(String((e as any).stderr))) throw e;
      return run();
    }
  });

const api = (path: string): any => JSON.parse(apiText(path));
const tryApi = (path: string): any => {
  try {
    return api(path);
  } catch {
    return undefined;
  }
};

const raw = async (repo: string, ref: string, path: string): Promise<string | undefined> => {
  const key = `raw:${repo}@${ref}:${path}`;
  const file = join(CACHE, createHash('sha1').update(key).digest('hex'));
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < DAY) return readFileSync(file, 'utf8');

  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/${path}`);
  if (!res.ok) return undefined;
  const text = await res.text();
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, text);
  return text;
};

// ---------- small helpers ----------

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.max(0, Math.ceil(q * s.length) - 1)]! : NaN;
};
const median = (xs: number[]) => pct(xs, 0.5);
const minutes = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60000;
const seconds = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 1000;
const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const share = (n: number, d: number) => (d ? n / d : NaN);
const count = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};
const groupBy = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};
/** Linear in log(x) between (good, 100) and (bad, 0), clamped. */
const logScore = (x: number, good: number, bad: number) => {
  if (!Number.isFinite(x)) return NaN;
  const t = (Math.log(Math.max(x, 1e-9)) - Math.log(good)) / (Math.log(bad) - Math.log(good));
  return 100 * Math.min(1, Math.max(0, 1 - t));
};
/** Points from anchors [value, points], linear in log(value) between them, clamped at the ends. */
const anchored = (x: number, anchors: [number, number][]) => {
  if (!Number.isFinite(x)) return NaN;
  if (x <= anchors[0]![0]) return anchors[0]![1];
  for (let i = 1; i < anchors.length; i++) {
    const [x0, y0] = anchors[i - 1]!;
    const [x1, y1] = anchors[i]!;
    if (x <= x1) return y0 + ((y1 - y0) * Math.log(x / x0)) / Math.log(x1 / x0);
  }
  return anchors.at(-1)![1];
};
// What a developer feels. 5 minutes is ci-doctor's PR budget; past 8 the score falls fast, so a 20-minute wait reads slow.
// Calibrated 19 Nov against the trusted research labels (calibration.md).
export const WAIT_P50: [number, number][] = [[3, 100], [5, 90], [8, 80], [12, 65], [20, 45], [45, 15], [120, 0]];
export const WAIT_P90: [number, number][] = [[5, 100], [8, 90], [15, 75], [22, 60], [40, 40], [90, 10], [180, 0]];

// S+ for 97 and up, then letters at 90, 75, 60 and 50 with a + on each band's top: A+ 94–96, A 90–93; B+ 85–89, B 75–84;
// C+ 70–74, C 60–69; D+ 57–59, D 50–56. F, under 50, has no sign.
const GRADES: [number, string][] = [[97, 'S+'], [94, 'A+'], [90, 'A'], [85, 'B+'], [75, 'B'], [70, 'C+'], [60, 'C'], [57, 'D+'], [50, 'D']];
export const grade = (score: number | null) => (score === null ? null : (GRADES.find(([from]) => score >= from)?.[1] ?? 'F'));
export const band = (score: number | null) =>
  score === null ? null : score >= 90 ? 'excellent' : score >= 75 ? 'fast' : score >= 50 ? 'ok' : 'slow';

const linScore = (x: number, good: number, bad: number) =>
  Number.isFinite(x) ? 100 * Math.min(1, Math.max(0, 1 - (x - good) / (bad - good))) : NaN;

// ---------- runs: the outcomes ----------

const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);
// Workflows that run on PRs but don't gate a merge; left out of the wait, listed in the report.
const NOT_A_CHECK =
  /claude|codex|copilot|coderabbit|gemini|greptile|sourcery|ai.?review|pr.?review|label|triage|welcome|greet|stale|lock|assign|size|auto-?merge|preview|deploy|benchmark|codspeed|bundle.?(size|analy)|release|publish|cla\b|first.?interaction|backport|comment/i;
const DONE = new Set(['success', 'failure']);
const PUSH_WINDOW = 10 * 60e3;
const MIN_TIMED = 5;
const isBotActor = (login = '') => /\[bot\]$|^(renovate|dependabot|github-actions|copilot-swe-agent)/i.test(login);

interface Run {
  id: number;
  name: string;
  path: string;
  event: string;
  head_sha: string;
  head_branch: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  created_at: string;
  updated_at: string;
  run_started_at: string;
  actor?: { login: string };
}

/** One stream of completed runs, such as PR runs or pushes to main, newest first. */
const readRuns = (repo: string, since: string, filter: string, pages: number) => {
  const runs: Run[] = [];
  let total = 0;
  for (let page = 1; page <= pages; page++) {
    const res = api(`repos/${repo}/actions/runs?${filter}&created=%3E%3D${since}&per_page=100&page=${page}&exclude_pull_requests=true`);
    total = res.total_count;
    runs.push(...res.workflow_runs);
    if (res.workflow_runs.length < 100) break;
  }
  const done = runs.filter((r) => r.status === 'completed');
  const days = done.length ? minutes(done.at(-1)!.created_at, done[0]!.created_at) / 1440 : 0;
  return { runs: done, total, fetched: runs.length, days };
};

// A run that sat over an hour before starting was waiting for a maintainer's approval (a fork's PR)
// or an environment, not for CI: its clock starts when it started.
const startOf = (r: Run) =>
  r.run_attempt === 1 && Date.parse(r.run_started_at) - Date.parse(r.created_at) > 60 * 60e3 ? r.run_started_at : r.created_at;

/** For each pushed head: the wait from the first workflow's start to the last one's end. */
/** A rerun run's first attempt: failed, cancelled or green. One call each, capped per report. */
const firstAttempts = (repo: string, cap: number) => {
  const seen = new Map<number, string | undefined>();
  return (run: Run): string | undefined => {
    if (run.run_attempt === 1) return run.conclusion ?? undefined;
    if (!seen.has(run.id) && seen.size < cap) seen.set(run.id, tryApi(`repos/${repo}/actions/runs/${run.id}/attempts/1`)?.conclusion ?? undefined);
    return seen.get(run.id);
  };
};

const waits = (runs: Run[], first: (run: Run) => string | undefined = () => undefined, heavy?: Set<string>) => {
  const heads = groupBy(runs, (r) => r.head_sha);
  const clean: { sha: string; wait: number; last: string; red: boolean }[] = [];
  let rerunHeads = 0;
  let passedOnRerun = 0;
  let cancelledHeads = 0;
  let redHeads = 0;
  let botHeads = 0;
  let lightHeads = 0;
  const redBy: string[] = [];
  for (const [sha, rs] of heads) {
    // One push starts its runs together. A run created later came from another event, such as a
    // label, a comment or an approval, so it isn't part of this push's wait.
    const ran = rs.filter((r) => r.conclusion !== 'skipped' && r.conclusion !== 'neutral' && r.conclusion !== 'action_required');
    if (!ran.length) continue;
    const pushedAt = Math.min(...ran.map((r) => Date.parse(r.created_at)));
    const counted = ran.filter((r) => Date.parse(r.created_at) - pushedAt <= PUSH_WINDOW);
    const startedAt = counted.map(startOf).sort()[0]!;
    const byBot = counted.every((r) => isBotActor(r.actor?.login));
    const reruns = counted.filter((r) => r.run_attempt > 1);
    // Green only on a rerun: the first attempt failed and the latest passed.
    const flaked = reruns.some((r) => r.conclusion === 'success' && first(r) === 'failure');
    const red = flaked || counted.some((r) => r.conclusion === 'failure');
    if (red) {
      redHeads++;
      for (const r of counted) if (r.conclusion === 'failure' || (r.run_attempt > 1 && first(r) === 'failure')) redBy.push(r.name);
    }
    if (reruns.length) {
      rerunHeads++;
      if (flaked) passedOnRerun++;
      continue;
    }
    if (counted.some((r) => r.conclusion === 'cancelled')) {
      cancelledHeads++;
      continue;
    }
    if (!counted.every((r) => DONE.has(r.conclusion ?? ''))) continue;
    // Time only pushes that ran the real work; a push that ran only quick checks says little.
    if (heavy?.size && !counted.some((r) => heavy.has(r.name))) {
      lightHeads++;
      continue;
    }
    // Nobody waits on a bot's push.
    if (byBot) {
      botHeads++;
      continue;
    }
    const start = startedAt;
    const lastRun = counted.reduce((a, b) => (a.updated_at > b.updated_at ? a : b));
    clean.push({ sha, wait: minutes(start, lastRun.updated_at), last: lastRun.name, red });
  }
  const all = heads.size;
  const w = clean.map((c) => c.wait);
  return {
    heads: all,
    timed: clean.length,
    p50: pct(w, 0.5),
    p75: pct(w, 0.75),
    p90: pct(w, 0.9),
    redRate: share(redHeads, all),
    rerunRate: share(rerunHeads, all),
    passedOnRerunRate: share(passedOnRerun, all),
    cancelledRate: share(cancelledHeads, all),
    botHeads,
    lightHeads,
    lastToFinish: count(clean, (c) => c.last).slice(0, 3),
    redBy: count(redBy, (n) => n).slice(0, 3),
  };
};

// ---------- jobs: queue, setup, rounding, the critical job, shards ----------

const SETUP_STEP =
  /^(set up job|complete job|post |checkout|run actions\/checkout)|checkout|setup|set up|install|cache|restore|download|toolchain|login|docker pull|pnpm i\b|npm ci|yarn( install)?$|bun install|uv sync|pip install/i;

const provider = (labels: string[]) => {
  const l = labels.join(' ').toLowerCase();
  if (l.includes('blacksmith')) return 'Blacksmith';
  if (l.includes('depot')) return 'Depot';
  if (l.includes('namespace') || l.includes('nscloud')) return 'Namespace';
  if (l.includes('buildjet')) return 'BuildJet';
  if (l.includes('warp')) return 'WarpBuild';
  if (l.includes('ubicloud')) return 'Ubicloud';
  if (l.includes('runs-on')) return 'RunsOn';
  if (l.includes('self-hosted')) return 'self-hosted';
  if (/ubuntu|windows|macos/.test(l) && /core|large|xl|arm64|gpu/.test(l)) return 'GitHub larger';
  if (/ubuntu|windows|macos/.test(l)) return 'GitHub-hosted';
  return labels[0] ?? 'unknown';
};

const SHARD = /\b(\d+)\s*\/\s*(\d+)\b|\bshard[\s_-]*(\d+)/i;

interface Job {
  id: number;
  name: string;
  conclusion: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  labels: string[];
  steps?: { name: string; started_at: string | null; completed_at: string | null; conclusion: string | null }[];
}

const readJobs = (repo: string, runId: number): Job[] => {
  const jobs: Job[] = [];
  for (let page = 1; page <= 3; page++) {
    const res = api(`repos/${repo}/actions/runs/${runId}/attempts/1/jobs?per_page=100&page=${page}`);
    jobs.push(...res.jobs);
    if (res.jobs.length < 100) break;
  }
  return jobs.filter((j) => j.conclusion !== 'skipped' && j.started_at && j.completed_at);
};

const jobStats = (jobs: Job[]) => {
  const dur = (j: Job) => minutes(j.started_at!, j.completed_at!);
  const runStart = jobs.map((j) => j.created_at).sort()[0]!;
  const runEnd = jobs.map((j) => j.completed_at!).sort().at(-1)!;
  const span = minutes(runStart, runEnd);
  const critical = jobs.reduce((a, b) => (a.completed_at! > b.completed_at! ? a : b));
  const longest = jobs.reduce((a, b) => (dur(a) > dur(b) ? a : b));

  let setup = 0;
  let work = 0;
  for (const j of jobs)
    for (const s of j.steps ?? []) {
      if (!s.started_at || !s.completed_at) continue;
      const t = seconds(s.started_at, s.completed_at);
      if (SETUP_STEP.test(s.name)) setup += t;
      else work += t;
    }

  // Shard groups: jobs whose names differ only by a shard index.
  const shardGroups = [...groupBy(jobs.filter((j) => SHARD.test(j.name)), (j) => j.name.replace(SHARD, '#'))]
    .filter(([, js]) => js.length >= 2)
    .map(([name, js]) => {
      const t = js.map(dur);
      const max = Math.max(...t);
      return {
        name,
        shards: js.length,
        medianMin: median(t),
        maxMin: max,
        maxOverMedian: max / median(t),
        idleTail: t.reduce((a, x) => a + (max - x), 0) / (max * t.length),
      };
    })
    .sort((a, b) => b.maxMin - a.maxMin);

  return {
    jobs: jobs.length,
    spanMin: span,
    jobMinutes: jobs.reduce((a, j) => a + dur(j), 0),
    billedMinutes: jobs.reduce((a, j) => a + Math.max(1, Math.ceil(dur(j))), 0),
    subMinuteJobs: jobs.filter((j) => dur(j) < 1).length,
    queueSec: jobs.map((j) => seconds(j.created_at, j.started_at!)),
    setupShare: share(setup, setup + work),
    critical: { name: critical.name, id: critical.id, minutes: dur(critical), shareOfSpan: dur(critical) / span },
    longest: { name: longest.name, id: longest.id, minutes: dur(longest) },
    providers: jobs.map((j) => provider(j.labels)),
    shardGroups,
  };
};

// ---------- logs: the slowest test files ----------

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const TEST_LINE: [RegExp, (m: RegExpMatchArray) => { file: string; sec: number }][] = [
  // Vitest: ✓ [project] path/to/file.test.ts (12 tests) 345ms
  [/[✓✗×❯]\s+(?:\S+\s+)?(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\(\d+ tests?[^)]*\)\s+([\d.]+)(ms|s)\b/, (m) => ({ file: m[1]!, sec: +m[2]! / (m[3] === 'ms' ? 1000 : 1) })],
  // Jest: PASS path/to/file.test.ts (5.123 s)
  [/\b(?:PASS|FAIL)\s+(?:\S+\s+)?(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\(([\d.]+) ?s\)/, (m) => ({ file: m[1]!, sec: +m[2]! })],
  // Go: ok  	pkg/path	1.234s
  [/^\s*(?:ok|FAIL)\s+(\S+)\s+([\d.]+)s\b/, (m) => ({ file: m[1]!, sec: +m[2]! })],
  // nextest: PASS [   1.234s] crate::test
  [/\b(?:PASS|FAIL|SLOW)\s+\[\s*([\d.]+)s\]\s+(.+)$/, (m) => ({ file: m[2]!.replace(/^\([^)]*\)\s*/, "").trim(), sec: +m[1]! })],
  // pytest --durations: 1.23s call     tests/test_x.py::test_y
  [/^\s*([\d.]+)s\s+(?:call|setup|teardown)\s+(\S+)/, (m) => ({ file: m[2]!.split('::')[0]!, sec: +m[1]! })],
];

const slowTests = (repo: string, jobs: { id: number; name: string }[]) => {
  const files: { file: string; sec: number; job: string }[] = [];
  let read = 0;
  for (const job of jobs) {
    let text: string;
    try {
      text = apiText(`repos/${repo}/actions/jobs/${job.id}/logs`);
    } catch {
      continue;
    }
    read++;
    for (const line of text.split('\n')) {
      const clean = line.replace(ANSI, '').replace(/^\S+Z\s/, '');
      for (const [re, f] of TEST_LINE) {
        const m = clean.match(re);
        if (m) {
          files.push({ ...f(m), job: job.name });
          break;
        }
      }
    }
  }
  // A file in two projects or shards counts once, at its slowest.
  const byFile = [...groupBy(files, (f) => f.file)].map(([, fs]) => fs.reduce((a, b) => (a.sec > b.sec ? a : b)));
  byFile.sort((a, b) => b.sec - a.sec);
  return { logsRead: read, filesTimed: byFile.length, over10s: byFile.filter((f) => f.sec > 10).length, top: byFile.slice(0, 5) };
};

// ---------- static practices: the tree and the workflow files ----------

const practices = async (repo: string, ref: string, tree: Set<string>) => {
  const has = (p: string | RegExp) => (typeof p === 'string' ? tree.has(p) : [...tree].some((x) => p.test(x)));
  const workflowPaths = [...tree].filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).slice(0, 40);
  const workflows = (await Promise.all(workflowPaths.map((p) => raw(repo, ref, p)))).filter((x): x is string => !!x);
  const all = workflows.join('\n');
  const onPr = workflows.filter((w) => /pull_request/.test(w)).join('\n');
  const pkg = (await raw(repo, ref, 'package.json')) ?? '';
  const nx = has('nx.json') ? ((await raw(repo, ref, 'nx.json')) ?? '') : '';
  const dependabot = has('.github/dependabot.yml') ? ((await raw(repo, ref, '.github/dependabot.yml')) ?? '') : '';
  const yes = (re: RegExp, text = all) => re.test(text);

  return {
    workflows: workflowPaths.length,
    // B. Running less
    cancelInProgress: yes(/cancel-in-progress:\s*(true|\$\{\{)/, onPr),
    pathFilters: yes(/^\s*paths(-ignore)?:|dorny\/paths-filter|changed-files/m, onPr),
    affected: yes(/--affected|nx affected|--filter=[^\s]*\.\.\.\[|vitest[^\n]*--changed|bazel-diff|target-determinator|turbo-ignore/),
    draftSkip: yes(/draft\s*==\s*false|!\s*github\.event\.pull_request\.draft|ready_for_review/, onPr),
    mergeQueue: yes(/merge_group/),
    scheduled: yes(/^\s*schedule:/m),
    // C. Reusing work
    depCache: yes(/actions\/cache|cache:\s*['"]?(npm|pnpm|yarn|pip|poetry|gradle|maven|bun|sbt)|enable-cache|cache-dependency-path|rust-cache|setup-gradle/),
    remoteCache: yes(/TURBO_TOKEN|TURBO_REMOTE|NX_CLOUD|nx-cloud|--remote_cache|--remote_executor|buildbuddy|VP_REMOTE|gradle-enterprise|develocity/i) || /nxCloud/.test(nx),
    compilerCache: yes(/rust-cache|sccache|ccache/),
    frozenInstall: yes(/--frozen-lockfile|npm ci\b|--immutable|--locked|--frozen\b/),
    // D. Shards and runners
    shardsConfigured: yes(/--shard|shardIndex|shard_index|total-shards|split-tests|knapsack|--partition/i),
    timeouts: yes(/timeout-minutes/),
    // E. Workspace tooling
    taskRunner:
      ['turbo.json', 'nx.json', 'MODULE.bazel', 'WORKSPACE', 'moon.yml', '.moon/workspace.yml', 'pants.toml'].find((p) => has(p)) ??
      (/"vite-plus"/.test(pkg) ? 'vite-plus' : undefined),
    packageManager: has('pnpm-lock.yaml') ? 'pnpm' : has(/^bun\.lockb?$/) ? 'bun' : has('yarn.lock') ? (has('.yarnrc.yml') ? 'yarn berry' : 'yarn 1') : has('package-lock.json') ? 'npm' : undefined,
    fastLint: has(/^biome\.jsonc?$/) || has(/^\.?oxlintrc\.json$/) || /"(oxlint|@biomejs\/biome)"/.test(pkg),
    eslint: /"eslint"/.test(pkg) || has(/^(\.eslintrc(\.\w+)?|eslint\.config\.[cm]?[jt]s)$/),
    testRunner: /"vitest"/.test(pkg) || has(/^vitest\.(config|workspace)\./)
      ? 'vitest'
      : /"jest"/.test(pkg) || has(/^jest\.config\./)
        ? 'jest'
        : yes(/cargo nextest/) || has('.config/nextest.toml')
          ? 'nextest'
          : yes(/pytest[^\n]*-n\s/) ? 'pytest-xdist' : undefined,
    // F. Tests and flakes
    testResults: yes(/junit|buildpulse|trunk-io|test-results|test-reporter|codecov\/test-results-action/i),
    // G. Health
    depBotsBatched: (has(/^(\.github\/)?renovate\.json5?$|^\.renovaterc/) ) || /groups:/.test(dependabot),
    // H. Ready for agents
    agentsMd: ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'].filter((p) => has(p)),
    agentRules: has(/^\.cursor\/rules\//) || has(/^\.(agents|claude)\/skills\//),
    preCommit: has('lefthook.yml') || has(/^\.husky\//) || has('.pre-commit-config.yaml'),
  };
};

// ---------- profile: how big, how busy, how fast it moves ----------

export const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|rs|py|go|vue|svelte|astro|java|kt|kts|scala|c|h|cc|cpp|hpp|cs|swift|rb|php|ex|exs|zig|dart|lua|css|scss)$/i;
// Not the repo's own code: dot-folders (copies of other repos such as .repos/, editor and tool state), vendored and
// third-party code, build output, generated code and patches. t3code's .repos/ alone made its count 7.3M instead of ~2.6M.
export const SKIP = /(^|\/)(\.[^/]+|node_modules|vendor|vendored|third[_-]?party|external|dist|build|out|target|coverage|generated|_generated|__generated__|patches)\/|\.min\.[jt]s$|\.d\.ts$|\.gen\.[a-z]+$|[._-]generated\.[a-z]+$|\.pb\.go$|_pb2\.py$/i;
export const MAX_SOURCE_FILE = 1_000_000; // bigger files are bundles or data, not code people wrote
const INTEGRATION = /(^|\/)(e2e|integration|integration-tests|playwright|cypress|smoke|live)(\/|[._-])|\.(e2e|integration|live|browser|smoke)\.(test|spec)\./i;
const SUPPORT = /(^|\/)(fixtures?|__fixtures__|__mocks__|mocks|testdata|test-?utils|test-?helpers|testing|__snapshots__|snapshots)\/|\.snap$/i;
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rs)$|(^|\/)test_[^/]*\.py$|(^|\/)(tests?|__tests__|spec|specs)\//i;
export const BYTES_PER_LINE = 30; // GitHub's language bytes ÷ lines, measured 28–31 on hono, vite and ruff, 18 Nov 2026

const kindOf = (path: string) =>
  INTEGRATION.test(path) ? 'integration' : SUPPORT.test(path) ? 'support' : TEST.test(path) ? 'tests' : 'implementation';

const profileOf = (repo: string, meta: any, tree: any, prRunCount: number, coveredDays: number) => {
  const blobs: { path: string; size: number }[] = (tree?.tree ?? []).filter((t: any) => t.type === 'blob');
  const code = blobs.filter((b) => CODE_EXT.test(b.path) && !SKIP.test(b.path) && (b.size ?? 0) <= MAX_SOURCE_FILE);
  const bytes = { implementation: 0, tests: 0, integration: 0, support: 0 } as Record<string, number>;
  for (const b of code) bytes[kindOf(b.path)]! += b.size ?? 0;
  const codeBytes = Object.values(bytes).reduce((a, x) => a + x, 0);
  const lines = (n: number) => Math.round(n / BYTES_PER_LINE);
  const notExample = (p: string) => !/(^|\/)(examples?|fixtures?|__fixtures__|test|tests|e2e|templates?|benchmarks?|playground)\//i.test(p);
  const manifests = (name: RegExp) => blobs.filter((b) => name.test(b.path) && notExample(b.path) && !SKIP.test(b.path)).length;

  const languages = tryApi(`repos/${repo}/languages`) ?? {};
  const langTotal = Object.values(languages).reduce((a: number, x: any) => a + x, 0) as number;

  // Commits on the default branch in the last 28 days, and who wrote them.
  const since28 = new Date(Date.now() - 28 * DAY).toISOString();
  const commits: any[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = tryApi(`repos/${repo}/commits?sha=${meta.default_branch}&since=${since28}&per_page=100&page=${page}`) ?? [];
    commits.push(...res);
    if (res.length < 100) break;
  }
  const authors = new Set(commits.map((c) => c.author?.login ?? c.commit?.author?.email).filter((a) => a && !String(a).endsWith('[bot]')));

  // The year's weekly commits, to see whether it's speeding up.
  const participation = tryApi(`repos/${repo}/stats/participation`)?.all as number[] | undefined;
  const yearWeekly = participation?.length ? participation.reduce((a, x) => a + x, 0) / participation.length : NaN;
  const lastMonthWeekly = participation?.length ? participation.slice(-4).reduce((a, x) => a + x, 0) / 4 : NaN;

  // Merged PRs in the last 7 days: how many, and opened (or marked ready) to merged.
  const since7 = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
  const merged = tryApi(`search/issues?q=${encodeURIComponent(`repo:${meta.full_name} is:pr is:merged merged:>=${since7}`)}&per_page=100&sort=updated`);
  const opened = tryApi(`search/issues?q=${encodeURIComponent(`repo:${meta.full_name} is:pr created:>=${since7}`)}&per_page=1`);
  const items: any[] = merged?.items ?? [];
  const isBot = (i: any) => i.user?.type === 'Bot' || /\[bot\]$|^(renovate|dependabot)/.test(i.user?.login ?? '');
  const openToMerge = items.filter((i) => i.pull_request?.merged_at && !isBot(i)).map((i) => (Date.parse(i.pull_request.merged_at) - Date.parse(i.created_at)) / 3600e3);
  const botPrs = items.filter(isBot).length;
  const mergedPerWeek = merged?.total_count ?? NaN;

  return {
    ageYears: r1((Date.now() - Date.parse(meta.created_at)) / (365 * DAY)),
    stars: meta.stargazers_count,
    forks: meta.forks_count,
    languages: Object.entries(languages).slice(0, 4).map(([l, b]) => [l, Math.round(((b as number) / langTotal) * 100)]),
    // Lines of the repo's own source, from the tree's file sizes. GitHub's language bytes count vendored copies and
    // generated code a repo hasn't marked, so they are only the fallback, when the tree is truncated or empty.
    linesOfCode: !tree?.truncated && codeBytes > 0 ? lines(codeBytes) : lines(langTotal),
    linesFrom: !tree?.truncated && codeBytes > 0 ? 'tree' : 'languages',
    files: blobs.length,
    sourceFiles: code.length,
    treeTruncated: !!tree?.truncated,
    // Shares of counted source by kind, from file sizes in the tree.
    sourceLines: {
      implementation: lines(bytes.implementation!),
      tests: lines(bytes.tests!),
      integration: lines(bytes.integration!),
      support: lines(bytes.support!),
    },
    testShare: share(bytes.tests! + bytes.integration! + bytes.support!, codeBytes),
    packages: {
      npm: manifests(/(^|\/)package\.json$/),
      cargo: manifests(/(^|\/)Cargo\.toml$/),
      go: manifests(/(^|\/)go\.mod$/),
      python: manifests(/(^|\/)(pyproject\.toml|setup\.py)$/),
    },
    commitsPerWeek: r1((commits.length / 4) * (commits.length >= 500 ? NaN : 1)) ?? `≥${Math.round(500 / 4)}`,
    commitsPerWeekYear: r1(yearWeekly),
    pace: Number.isFinite(lastMonthWeekly / yearWeekly) ? r1(lastMonthWeekly / yearWeekly) : null,
    activeAuthors28d: commits.length >= 500 ? `≥${authors.size}` : authors.size,
    prsOpenedPerWeek: opened?.total_count ?? null,
    prsMergedPerWeek: mergedPerWeek,
    botShareOfMergedPrs: r1(share(botPrs, items.length) * 100),
    // People's PRs only: bots' are often merged in minutes.
    openToMergeHours: { p50: r1(median(openToMerge)), p90: r1(pct(openToMerge, 0.9)), n: openToMerge.length },
    prRunsPerDay: r1(prRunCount / Math.max(coveredDays, 0.5)),
    runsPerMergedPr: r1((prRunCount / Math.max(coveredDays, 0.5)) * 7 / mergedPerWeek),
  };
};

// ---------- score and fixes ----------

type Practices = Awaited<ReturnType<typeof practices>>;

// The larger of two classes: by code and by PR traffic.
export const sizeClass = (headsPerWeek: number, linesOfCode: number) => {
  const names = ['tiny', 'small', 'medium', 'large'] as const;
  const byTraffic = headsPerWeek < 10 ? 0 : headsPerWeek < 50 ? 1 : headsPerWeek < 250 ? 2 : 3;
  const byCode = linesOfCode < 20_000 ? 0 : linesOfCode < 200_000 ? 1 : linesOfCode < 1_000_000 ? 2 : 3;
  return names[Math.max(byTraffic, byCode)]!;
};

/** PR CI job minutes in the window, across every workflow: 2 sampled runs each, scaled by run count. */
const ciMinutes = (repo: string, prRuns: Run[]) => {
  const ran = prRuns.filter((r) => ['success', 'failure', 'cancelled'].includes(r.conclusion ?? ''));
  const byWorkflow = [...groupBy(ran, (r) => r.name)].sort((x, y) => y[1].length - x[1].length);
  const perRun: number[] = [];
  const billedPerRun: number[] = [];
  let minutes = 0;
  let billed = 0;
  let sampledRuns = 0;
  const totals = new Map<string, number>();
  for (const [, rs] of byWorkflow.slice(0, 12)) {
    // The 3 runs nearest the workflow's median duration, so a run whose jobs were all skipped, or an
    // unusually long one, doesn't stand for the workflow.
    const length = (r: Run) => Date.parse(r.updated_at) - Date.parse(r.run_started_at);
    const usable = rs.filter((r) => r.run_attempt === 1 && r.conclusion !== 'cancelled').sort((x, y) => length(x) - length(y));
    const mid = Math.floor(usable.length / 2);
    const sample = usable.slice(Math.max(0, mid - 1), mid + 2);
    const jobs = sample.map((r) => readJobs(repo, r.id));
    if (!jobs.length) continue;
    const dur = (j: Job) => minutes_(j.started_at!, j.completed_at!);
    const m = median(jobs.map((js) => js.reduce((acc, j) => acc + dur(j), 0)));
    const bm = median(jobs.map((js) => js.reduce((acc, j) => acc + Math.max(1, Math.ceil(dur(j))), 0)));
    // A cancelled run usually stopped partway: count it as half.
    const weight = rs.filter((r) => r.conclusion !== 'cancelled').length + rs.filter((r) => r.conclusion === 'cancelled').length / 2;
    minutes += m * weight;
    totals.set(rs[0]!.name, m * weight);
    billed += bm * weight;
    perRun.push(m);
    billedPerRun.push(bm);
    sampledRuns += rs.length;
  }
  // Workflows past the top 12: at the sampled median.
  const rest = ran.length - sampledRuns;
  minutes += rest * (median(perRun) || 0);
  billed += rest * (median(billedPerRun) || 0);
  // The workflows that do the real work: the fewest that make up 80% of PR job-minutes.
  const heavy = new Set<string>();
  let covered = 0;
  for (const [name, m] of [...totals].sort((a, b) => b[1] - a[1])) {
    if (covered >= 0.8 * minutes && heavy.size) break;
    heavy.add(name);
    covered += m;
  }
  return { jobMinutes: minutes, billedMinutes: billed, workflows: byWorkflow.length, heavy };
};
const minutes_ = (a: string, b: string) => minutes(a, b);

// The p50 wait and the PR CI minutes per merged PR expected of a repo with this many lines, fitted log–log
// over 219 scored repos on 19 Nov (calibration.md). The fits are loose (r² 0.12 each): a fairness adjustment, not a prediction.
export const expectedWait = (linesOfCode: number) => Math.max(2, 10.9 * (Math.max(linesOfCode, 1) / 100_000) ** 0.23);
export const expectedMinutesPerMergedPr = (linesOfCode: number) => Math.max(10, 155 * (Math.max(linesOfCode, 1) / 100_000) ** 0.33);

export interface Inputs {
  p50: number;
  p90: number;
  linesOfCode: number;
  passedOnRerunRate: number;
  mainRedRate: number;
  minutesPerMergedPr: number;
  runsPerMergedPr: number;
  setupShare: number;
  queueP90Sec: number;
  shardIdleTail: number;
}

/** Three parts, each 0–100 from the parts of it that could be measured, weighted into one score. */
export const scoreOf = (o: Inputs) => {
  const parts = {
    // Speed leads: a slow but steady repo shouldn't reach B on reliability and efficiency alone.
    speed: {
      w: 60,
      of: {
        // What people feel: 3 minutes is full marks, 8 is 80, 20 is 45, 120 is zero.
        wait: { w: 20, s: anchored(o.p50, WAIT_P50) },
        // Fair to big repos: half the expected wait for this size is full marks, 2.5× is zero.
        forSize: { w: 15, s: logScore(o.p50 / expectedWait(o.linesOfCode), 0.5, 2.5) },
        // Light: a p90 many times the p50 is often a wait outside CI, such as an approval gate or a stuck run.
        tail: { w: 5, s: anchored(o.p90, WAIT_P90) },
      },
    },
    // Red PR heads aren't counted: people push failing work in progress, which measures contributors, not CI.
    reliability: {
      w: 20,
      of: {
        flakes: { w: 14, s: linScore(o.passedOnRerunRate, 0.01, 0.12) },
        mainRed: { w: 10, s: linScore(o.mainRedRate, 0.05, 0.4) },
      },
    },
    efficiency: {
      w: 20,
      of: {
        minutesPerPr: { w: 6, s: logScore(o.minutesPerMergedPr / expectedMinutesPerMergedPr(o.linesOfCode), 0.5, 4) },
        runsPerPr: { w: 4, s: logScore(o.runsPerMergedPr, 5, 60) },
        setup: { w: 4, s: linScore(o.setupShare, 0.2, 0.7) },
        queue: { w: 3, s: logScore(Math.max(o.queueP90Sec, 1), 10, 300) },
        shardIdle: { w: 3, s: linScore(o.shardIdleTail, 0.1, 0.4) },
      },
    },
  };
  const weigh = (xs: { w: number; s: number }[]) => {
    const known = xs.filter((x) => Number.isFinite(x.s));
    const w = known.reduce((a, x) => a + x.w, 0);
    return w ? known.reduce((a, x) => a + x.w * x.s, 0) / w : NaN;
  };
  const scored = Object.fromEntries(Object.entries(parts).map(([k, part]) => [k, { w: part.w, s: weigh(Object.values(part.of)) }])) as Record<keyof typeof parts, { w: number; s: number }>;
  return {
    score: Math.round(weigh(Object.values(scored))),
    parts: Object.fromEntries(Object.entries(scored).map(([k, v]) => [k, Math.round(v.s)])),
    detail: Object.fromEntries(Object.entries(parts).map(([k, part]) => [k, Object.fromEntries(Object.entries(part.of).map(([n, x]) => [n, Number.isFinite(x.s) ? Math.round(x.s) : null]))])),
  };
};

// The guide has stack pages for these; for any other main language, the report says the fixes apply the principles without one.
const STACK_PAGES = new Set(['TypeScript', 'JavaScript', 'Rust']);
const stackNote = (language: string | undefined) =>
  language && !STACK_PAGES.has(language)
    ? [{ text: `ci-doctor's guides are strongest for TypeScript and Rust. For ${language} it applies the principles, without a ${language}-specific page`, guide: GUIDE + '01-principles.md' }]
    : [];

const fixesOf = (o: any, pr: Practices) => {
  const fixes: { text: string; page: string; weight: number }[] = [];
  const slow = o.wait.p50 > 5;
  const add = (when: unknown, weight: number, text: string | (() => string), page: string) =>
    when && fixes.push({ text: typeof text === "string" ? text : text(), page, weight });

  add(slow && !pr.affected && !pr.pathFilters, 9, 'Run only what a change can reach: no path filters or affected-only selection on PR workflows', '04-run-only-what-a-change-can-reach.md');
  add(slow && !pr.remoteCache && !!pr.taskRunner, 8, () => `Share a remote cache for ${pr.taskRunner}: it has none in CI`, '06-reuse-work-by-its-real-inputs.md');
  add(o.jobs?.setupShare > 0.35 && o.jobs.spanMin > 4, 7, () => `Setup is ${Math.round(o.jobs.setupShare * 100)}% of job time: cache dependencies and build once`, '06-reuse-work-by-its-real-inputs.md');
  add(o.jobs?.shard && o.jobs.shard.maxOverMedian > 1.25, 7, () => `"${o.jobs.shard.name}": the slowest shard takes ${o.jobs.shard.maxOverMedian.toFixed(2)}× the median, ${Math.round(o.jobs.shard.idleTail * 100)}% idle; balance shards by measured time`, '07-shards-runners-and-billing.md');
  add(slow && !o.jobs?.shard && !pr.shardsConfigured && o.jobs?.longest.minutes > 8, 6, () => `"${o.jobs?.longest.name}" runs ${Math.round(o.jobs?.longest.minutes)} min in one job: shard it`, '07-shards-runners-and-billing.md');
  add(o.tests?.over10s > 0, 6, () => `${o.tests?.over10s} test files take over 10 s; the slowest, ${o.tests?.top[0]?.file}, takes ${Math.round(o.tests?.top[0]?.sec)} s`, '10-slow-tests-the-method.md');
  add(o.wait.passedOnRerunRate > 0.03, 6, () => `${Math.round(o.wait.passedOnRerunRate * 100)}% of PR heads went green only on a rerun: track and fix flakes`, '11-flakes.md');
  add(o.wait.p90 > 2 * o.wait.p50 && o.wait.p90 > 10, 5, () => `p90 is ${(o.wait.p90 / o.wait.p50).toFixed(1)}× p50: find what makes the slow runs slow`, '12-budgets-health-and-spend.md');
  add(o.jobs?.queueP90Sec > 60, 5, () => `Jobs wait ${Math.round(o.jobs.queueP90Sec)} s for a runner at p90${/^GitHub/.test(o.jobs.providers[0]?.[0] ?? '') ? ': GitHub-hosted runners are often slow to start, so price a faster provider' : ''}`, '02-runners-blacksmith-and-the-cost-of-getting-fast.md#when-jobs-wait-to-start');
  add(o.jobs?.subMinuteJobs / o.jobs?.jobs > 0.4 && o.jobs.billedMinutes > 1.5 * o.jobs.jobMinutes && o.jobs.providers[0]?.[0] !== 'GitHub-hosted', 3, () => `${o.jobs?.subMinuteJobs} of ${o.jobs?.jobs} jobs finish in under a minute but bill a whole one: merge them`, '07-shards-runners-and-billing.md');
  add(!pr.cancelInProgress, 4, 'Cancel superseded PR runs: no concurrency with cancel-in-progress', '04-run-only-what-a-change-can-reach.md');
  add(slow && !pr.scheduled, 3, 'Move broad checks to a scheduled sweep', '05-tiers-what-runs-where.md');
  add(!pr.timeouts, 2, 'Set timeout-minutes on jobs', '03-workflow-anatomy.md');
  add(slow && pr.eslint && !pr.fastLint, 2, 'Lint with Oxlint or Biome', '09-workspace-tooling.md');
  add(slow && pr.testRunner === 'jest', 2, 'Jest: consider Vitest', '09-workspace-tooling.md');

  return fixes.sort((a, b) => b.weight - a.weight).map(({ text, page }) => ({ text, guide: GUIDE + page }));
};

// ---------- one repo ----------

const scoreRepo = async (repo: string, days: number) => {
  calls = 0;
  const meta = api(`repos/${repo}`);
  const since = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  // PR runs and pushes to main are read as separate streams, so a busy repo's bots, schedules and
  // other events don't crowd the PR runs out of the window.
  const prStream = readRuns(repo, since, 'event=pull_request', MAX_RUN_PAGES);
  const targetStream = readRuns(repo, since, 'event=pull_request_target', 2);
  const mainStream = readRuns(repo, since, `event=push&branch=${encodeURIComponent(meta.default_branch)}`, 3);
  const runs = [...prStream.runs, ...targetStream.runs, ...mainStream.runs];
  const total = prStream.total;
  const covered = prStream.days;

  const prRuns = runs.filter((r) => PR_EVENTS.has(r.event));
  const gating = prRuns.filter((r) => !NOT_A_CHECK.test(r.name));
  const left = [...new Set(prRuns.filter((r) => NOT_A_CHECK.test(r.name)).map((r) => r.name))];
  const ci = ciMinutes(repo, gating);
  const first = firstAttempts(repo, 25);
  const wait = waits(gating, first, ci.heavy);
  const allPushes = waits(gating, first);
  const main = waits(runs.filter((r) => r.event === 'push' && r.head_branch === meta.default_branch && !NOT_A_CHECK.test(r.name)));
  const bots = share(runs.filter((r) => r.actor?.login.endsWith('[bot]')).length, runs.length);

  // Jobs of the workflow that most often finishes last.
  const lastName = wait.lastToFinish[0]?.[0];
  const sample = gating
    .filter((r) => r.name === lastName && r.conclusion === 'success' && r.run_attempt === 1)
    .slice(0, JOB_SAMPLE);
  const perRun = sample.map((r) => ({ run: r, jobs: readJobs(repo, r.id) })).filter((x) => x.jobs.length);
  const stats = perRun.map((x) => jobStats(x.jobs));
  const jobs = stats.length
    ? {
        runsSampled: stats.length,
        jobs: Math.round(median(stats.map((s) => s.jobs))),
        spanMin: median(stats.map((s) => s.spanMin)),
        jobMinutes: median(stats.map((s) => s.jobMinutes)),
        billedMinutes: median(stats.map((s) => s.billedMinutes)),
        subMinuteJobs: Math.round(median(stats.map((s) => s.subMinuteJobs))),
        queueP50Sec: pct(stats.flatMap((s) => s.queueSec), 0.5),
        queueP90Sec: pct(stats.flatMap((s) => s.queueSec), 0.9),
        setupShare: median(stats.map((s) => s.setupShare)),
        critical: count(stats, (s) => s.critical.name).slice(0, 1).map(([name]) => ({
          name,
          minutes: median(stats.filter((s) => s.critical.name === name).map((s) => s.critical.minutes)),
          shareOfSpan: median(stats.filter((s) => s.critical.name === name).map((s) => s.critical.shareOfSpan)),
        }))[0]!,
        longest: count(stats, (s) => s.longest.name).slice(0, 1).map(([name]) => ({
          name,
          minutes: median(stats.filter((s) => s.longest.name === name).map((s) => s.longest.minutes)),
        }))[0]!,
        providers: count(stats.flatMap((s) => s.providers), (p) => p).slice(0, 3),
        shard: stats[0]!.shardGroups[0]
          ? (() => {
              const name = stats[0]!.shardGroups[0]!.name;
              const gs = stats.map((s) => s.shardGroups.find((g) => g.name === name)).filter((g) => !!g);
              return {
                name,
                shards: gs[0]!.shards,
                medianMin: median(gs.map((g) => g.medianMin)),
                maxMin: median(gs.map((g) => g.maxMin)),
                maxOverMedian: median(gs.map((g) => g.maxOverMedian)),
                idleTail: median(gs.map((g) => g.idleTail)),
              };
            })()
          : undefined,
      }
    : undefined;

  // Logs of the newest sampled run's critical job and its slowest shard.
  let tests: ReturnType<typeof slowTests> | undefined;
  if (perRun[0]) {
    const s = jobStats(perRun[0].jobs);
    const picks = [s.longest, ...s.shardGroups.slice(0, 1).flatMap((g) => {
      const j = perRun[0]!.jobs.filter((x) => x.name.replace(SHARD, '#') === g.name).sort((a, b) => b.completed_at!.localeCompare(a.completed_at!))[0];
      return j ? [{ id: j.id, name: j.name }] : [];
    })];
    // The job that spends longest in steps named for tests.
    const testTime = (j: Job) =>
      (j.steps ?? []).filter((x) => /test|spec|vitest|jest|pytest|nextest/i.test(x.name) && x.started_at && x.completed_at)
        .reduce((a, x) => a + seconds(x.started_at!, x.completed_at!), 0);
    const testy = perRun[0].jobs
      .filter((j) => testTime(j) > 0)
      .sort((a, b) => testTime(b) - testTime(a))
      .slice(0, 2)
      .map((j) => ({ id: j.id, name: j.name }));
    const uniq = [...new Map([...testy, ...picks].map((j) => [j.id, j])).values()].slice(0, 3);
    tests = slowTests(repo, uniq);
  }

  const tree = tryApi(`repos/${repo}/git/trees/${meta.default_branch}?recursive=1`);
  const paths = new Set<string>((tree?.tree ?? []).map((t: any) => t.path));
  const pr = await practices(repo, meta.default_branch, paths);
  const profile = profileOf(repo, meta, tree, prRuns.length, covered);
  const mergedInWindow = (profile.prsMergedPerWeek * Math.max(covered, 0.5)) / 7;
  const efficiency = {
    prJobMinutesPerDay: r1(ci.jobMinutes / Math.max(covered, 0.5)),
    prBilledMinutesPerDay: r1(ci.billedMinutes / Math.max(covered, 0.5)),
    jobMinutesPerMergedPr: r1(ci.jobMinutes / mergedInWindow),
    expectedMinutesPerMergedPr: r1(expectedMinutesPerMergedPr(profile.linesOfCode)),
    expectedWait: r1(expectedWait(profile.linesOfCode)),
    workflowsOnPrs: ci.workflows,
  };

  const outcomes = { wait, jobs, tests };
  const { score, parts, detail } = scoreOf({
    p50: wait.p50,
    p90: wait.p90,
    linesOfCode: profile.linesOfCode,
    passedOnRerunRate: wait.passedOnRerunRate,
    mainRedRate: main.redRate,
    minutesPerMergedPr: ci.jobMinutes / mergedInWindow,
    runsPerMergedPr: profile.runsPerMergedPr ?? NaN,
    setupShare: jobs?.setupShare ?? NaN,
    queueP90Sec: jobs?.queueP90Sec ?? NaN,
    shardIdleTail: jobs?.shard?.idleTail ?? NaN,
  });

  // Too few timed pushes to say anything: no score, and the report says why.
  const enough = wait.timed >= MIN_TIMED;

  return {
    repo,
    date: new Date().toISOString().slice(0, 10),
    unscored: enough ? undefined : `Only ${wait.timed} PR pushes in the window ran the main workflows; ${MIN_TIMED} are needed.`,
    profile,
    window: { days: r1(covered), runs: prStream.runs.length, runsInPeriod: total, truncated: total > prStream.fetched, mainDays: r1(mainStream.days) },
    size: sizeClass((wait.heads / Math.max(covered, 0.5)) * 7, profile.linesOfCode),
    headsPerWeek: Math.round((wait.heads / Math.max(covered, 0.5)) * 7),
    score: enough ? score : null,
    grade: grade(enough ? score : null),
    band: band(enough ? score : null),
    parts: enough ? parts : {},
    detail,
    efficiency,
    wait: { ...wait, leftOut: left, heavyWorkflows: [...ci.heavy], allPushesP50: allPushes.p50 },
    main: { heads: main.heads, p50: main.p50, p90: main.p90, redRate: main.redRate, redBy: main.redBy },
    botRunShare: bots,
    jobs,
    tests,
    practices: pr,
    fixes: fixesOf(outcomes, pr),
    // Flags, not fixes: worth knowing, but not a CI problem the measurements show.
    notes: [
      ...(pr.agentsMd.length === 0 ? [{ text: 'No AGENTS.md: agents working here have no instructions, such as how to run one test', guide: GUIDE + '15-the-agent-workflow-around-ci.md' }] : []),
      ...stackNote(profile.languages[0]?.[0]),
    ],
    apiCalls: calls,
  };
};

// ---------- output ----------

type Report = Awaited<ReturnType<typeof scoreRepo>>;
const p = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–');
const m = (x: number | undefined) => (x !== undefined && Number.isFinite(x) ? x.toFixed(1) : '–');

const fmtK = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);
const pkgText = (pk: Record<string, number>) =>
  Object.entries(pk).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k === 'npm' ? 'npm package' : k === 'cargo' ? 'crate' : k === 'go' ? 'Go module' : 'Python project'}${n === 1 ? '' : 's'}`).join(', ') || 'one package';

const promptBlock = (r: Report) =>
  [
    `<ci-report repo="${r.repo}" date="${r.date}">`,
    `Score ${r.score}/100, grade ${r.grade}: speed ${r.parts.speed}, reliability ${r.parts.reliability}, efficiency ${r.parts.efficiency} (${r.size}: ${r.headsPerWeek} PR pushes a week)`,
    `Repo: ~${fmtK(r.profile.linesOfCode)} lines (${r.profile.languages.map(([l, s]) => `${l} ${s}%`).join(', ')}), tests ${p(r.profile.testShare)} of source, ${pkgText(r.profile.packages)}; ${r.profile.commitsPerWeek} commits/week by ${r.profile.activeAuthors28d} people (28 days, pace ${r.profile.pace ?? '–'}× the year); ${r.profile.prsMergedPerWeek} PRs merged/week, ${r.profile.botShareOfMergedPrs}% by bots, people's open→merge p50 ${r.profile.openToMergeHours.p50 ?? '–'} h; ${r.profile.runsPerMergedPr ?? '–'} PR runs per merged PR`,
    `PR wait p50 / p75 / p90: ${m(r.wait.p50)} / ${m(r.wait.p75)} / ${m(r.wait.p90)} min (pushes that ran ${r.wait.heavyWorkflows.map((w) => `"${w}"`).join(', ')}; all pushes p50 ${m(r.wait.allPushesP50)}) · queue p90 ${m(r.jobs?.queueP90Sec)} s · red heads ${p(r.wait.redRate)}${r.wait.redBy.length ? ` (${r.wait.redBy.map(([n, c]) => `${n} ×${c}`).join(', ')})` : ''} · green only on rerun ${p(r.wait.passedOnRerunRate)}`,
    `CI per merged PR: ${m(r.efficiency.jobMinutesPerMergedPr)} job-min across ${r.efficiency.workflowsOnPrs} PR workflows (expected for this size ~${r.efficiency.expectedMinutesPerMergedPr}); p50 wait expected for this size ~${r.efficiency.expectedWait} min; main red ${p(r.main.redRate)}`,
    r.jobs && `Last to finish: "${r.wait.lastToFinish[0]?.[0]}", ${r.jobs.jobs} jobs, ${m(r.jobs.jobMinutes)} job-min; run ${m(r.jobs.spanMin)} min; longest job "${r.jobs.longest.name}" ${m(r.jobs.longest.minutes)} min; setup ${p(r.jobs.setupShare)} of job time`,
    r.jobs?.shard && `Shards "${r.jobs.shard.name}": ${r.jobs.shard.shards}, slowest ${r.jobs.shard.maxOverMedian.toFixed(2)}× the median, ${p(r.jobs.shard.idleTail)} idle tail`,
    r.tests?.top.length && `Slowest test files: ${r.tests.top.slice(0, 3).map((t) => `${t.file} ${t.sec.toFixed(1)} s`).join(', ')}`,
    `Fix first: ${r.fixes.slice(0, 3).map((f, i) => `${i + 1}. ${f.text} (${f.guide.split('/').at(-1)!.slice(0, 2)})`).join('  ') || 'nothing urgent'}`,
    `</ci-report>`,
  ]
    .filter(Boolean)
    .join('\n');

const args = import.meta.main ? process.argv.slice(2) : [];
const days = Number(args[args.indexOf('--days') + 1]) || 7;
const json = args.includes('--json');
const repos = args.filter((a, i) => a.includes('/') && args[i - 1] !== '--days');

for (const repo of repos) {
  try {
    const r = await scoreRepo(repo, days);
    const dir = join(HERE, 'reports', repo.replace('/', '__'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${r.date}.json`), JSON.stringify(r, null, 1));
    if (json) console.log(JSON.stringify(r));
    else console.log(`\n== ${repo}  score ${r.score}  ${JSON.stringify(r.parts)}  (${r.apiCalls} API calls, ${r.window.days} days, ${r.window.runs}${r.window.truncated ? ` of ${r.window.runsInPeriod}` : ''} runs)\n${promptBlock(r)}`);
  } catch (e) {
    console.log(`\n== ${repo}  failed: ${(e as Error).message.split("\n")[0]}`); if (process.env.DEBUG) console.error(e);
  }
}
