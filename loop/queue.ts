// The night's queue: which repos the measure job checks, in order, and why. Computed from loop.db with no model:
//   1. due refreshes: an adopter 2 days after its last report, every other tracked repo 7 days after it;
//   2. gaps: cohorts (size class × main language, over each repo's latest scored report, as compare.ts takes them)
//      with fewer than 15 scored repos get new repos from GitHub search, each cohort's share of what's left of the
//      night set by how far it is under target.
// Usage: node loop/queue.ts --dry-run [--max <n>] [--no-search] [--db <file>]
//   prints the queue with each repo's reason. Gaps need GitHub's repo search, with the App's token (token.ts).
import type { DatabaseSync } from 'node:sqlite';

export const TARGET = 15; // scored repos a cohort should have
export const REFRESH_DAYS = 7; // so a repo's 7-day windows don't overlap
export const ADOPTER_DAYS = 2; // adopters' before and after
// The cohorts gaps fill: the main languages the dataset has, at the sizes that score. A tiny repo seldom has the
// 5 timed PR pushes a score needs, so tiny cohorts aren't searched for.
export const LANGUAGES = [
  'TypeScript', 'JavaScript', 'Python', 'Rust', 'Go', 'Java', 'Kotlin', 'C#', 'C++', 'C', 'Ruby', 'PHP', 'Swift', 'Elixir',
] as const;
export const SIZES = ['small', 'medium', 'large'] as const;

export type Reason = 'refresh' | 'adoption' | 'gap';
export type Entry = { repo: string; reason: Reason; why: string; cohort?: string; githubId?: number };
export type Gap = { size: string; language: string; n: number; under: number };

const DAY = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);
export const addDays = (date: string, n: number) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);
export const cohortKey = (size: string, language: string) => `${size} × ${language}`;

// Tracked repos due again on `today`, adopters first, then the longest overdue. A failed check counts as an attempt,
// so a repo that keeps failing is retried on the same cadence rather than every night. A repo whose every report was
// submitted is never due: what it costs to measure is its submitter's, not ours. Gap discovery leaves it out too, as a
// tracked repo.
export function dueRefreshes(db: DatabaseSync, today: string): Entry[] {
  const rows = db
    .prepare(
      `SELECT p.repo,
              (SELECT MAX(date) FROM reports r WHERE r.repo = p.repo AND r.seq = 0) AS last_report,
              (SELECT MAX(substr(at, 1, 10)) FROM checks c WHERE c.repo = p.repo AND c.report IS NULL) AS last_failed,
              EXISTS (SELECT 1 FROM adoption a WHERE a.repo = p.repo) AS adopter
         FROM repos p
        WHERE NOT EXISTS (SELECT 1 FROM reports r WHERE r.repo = p.repo)
           OR EXISTS (SELECT 1 FROM reports r WHERE r.repo = p.repo AND r.submitted_by IS NULL)`,
    )
    .all() as { repo: string; last_report: string | null; last_failed: string | null; adopter: number }[];

  const due: (Entry & { overdue: number; adopter: number })[] = [];
  for (const r of rows) {
    const last = [r.last_report, r.last_failed].filter((d): d is string => !!d).sort().at(-1);
    if (!last) continue;
    const every = r.adopter ? ADOPTER_DAYS : REFRESH_DAYS;
    const age = days(last, today);
    if (age < every) continue;
    const what = last === r.last_report ? `last report ${last}` : `last check failed ${last}`;
    due.push({
      repo: r.repo,
      reason: r.adopter ? 'adoption' : 'refresh',
      why: `${what}, ${age} days ago (every ${every})`,
      overdue: age - every,
      adopter: r.adopter,
    });
  }
  due.sort((a, b) => b.adopter - a.adopter || b.overdue - a.overdue || a.repo.localeCompare(b.repo));
  return due.map(({ overdue: _, adopter: __, ...e }) => e);
}

// Every target cohort under TARGET, the furthest under first.
export function cohortGaps(db: DatabaseSync): Gap[] {
  const have = new Map<string, number>();
  const rows = db
    .prepare(
      `SELECT r.size, r.language, COUNT(*) AS n FROM repos p JOIN reports r ON r.id = p.latest_report
        WHERE r.score IS NOT NULL GROUP BY r.size, r.language`,
    )
    .all() as { size: string; language: string; n: number }[];
  for (const r of rows) have.set(cohortKey(r.size, r.language), r.n);

  const gaps: Gap[] = [];
  for (const language of LANGUAGES)
    for (const size of SIZES) {
      const n = have.get(cohortKey(size, language)) ?? 0;
      if (n < TARGET) gaps.push({ size, language, n, under: TARGET - n });
    }
  const order = (g: Gap) => LANGUAGES.indexOf(g.language as never) * SIZES.length + SIZES.indexOf(g.size as never);
  return gaps.sort((a, b) => b.under - a.under || order(a) - order(b));
}

// Splits `slots` across the gaps in proportion to how far each is under, by largest remainder, none past its gap.
export function quotas(gaps: Gap[], slots: number): Map<string, number> {
  const out = new Map<string, number>();
  const total = gaps.reduce((s, g) => s + g.under, 0);
  if (slots <= 0 || total === 0) return out;
  const take = Math.min(slots, total);

  const shares = gaps.map((g, i) => ({ g, i, exact: (take * g.under) / total }));
  let given = 0;
  for (const s of shares) {
    const n = Math.min(s.g.under, Math.floor(s.exact));
    out.set(cohortKey(s.g.size, s.g.language), n);
    given += n;
  }
  // The rest, one each, to the largest remainders; ties go to the cohort furthest under, then the gaps' order.
  const rest = shares
    .filter((s) => (out.get(cohortKey(s.g.size, s.g.language)) ?? 0) < s.g.under)
    .sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) || b.g.under - a.g.under || a.i - b.i);
  for (const s of rest) {
    if (given >= take) break;
    const k = cohortKey(s.g.size, s.g.language);
    out.set(k, out.get(k)! + 1);
    given++;
  }
  for (const [k, n] of out) if (n === 0) out.delete(k);
  return out;
}

// ---------- finding new repos for the gaps ----------

// What discovery asks GitHub: a repo search (GraphQL, its own points limit) and a PR-runs count (core).
export type Candidate = {
  id: number; // GitHub's numeric repo id
  repo: string;
  fork: boolean;
  archived: boolean;
  private: boolean;
  language: string | null; // the main language
  bytes: number; // every language's bytes
  prs: number; // PRs opened since `since`, of the newest 100
};
export interface GitHub {
  // Public repos whose main language is `language`, with at least MIN_STARS stars, pushed since `since`: one page.
  searchRepos(language: string, since: string, page: number): Candidate[];
  prRuns(repo: string, since: string): number;
  // GitHub's numeric ids of these repos, by the names given; a renamed repo resolves to its new self.
  repoIds(repos: string[]): Map<string, number>;
}

export const SEARCH_PAGES = 4; // of 50 repos, per language
export const MIN_STARS = 100; // a search floor, so class projects and personal dashboards don't fill the gaps
export const CANDIDATES_PER_SLOT = 4; // PR-run counts read, at most, per slot a cohort has to fill
export const MIN_PR_RUNS = 5; // a score needs 5 timed PR pushes
export const BYTES_PER_LINE = 30; // the scorer's: GitHub's language bytes ÷ lines
export const HEADS_PER_PR = 2; // PR heads in a week per PR opened, roughly: a PR is pushed to again after review

// The scorer's size class, from lines of code and PR heads a week, the larger of the two.
export function predictSize(lines: number, headsPerWeek: number) {
  const names = ['tiny', 'small', 'medium', 'large'] as const;
  const byTraffic = headsPerWeek < 10 ? 0 : headsPerWeek < 50 ? 1 : headsPerWeek < 250 ? 2 : 3;
  const byCode = lines < 20_000 ? 0 : lines < 200_000 ? 1 : lines < 1_000_000 ? 2 : 3;
  return names[Math.max(byTraffic, byCode)]!;
}

// New repos for each language's cohort quotas: public repos pushed this week, the most PRs opened this week first,
// that aren't forks, archived or tracked and ran Actions on PRs. A repo's cohort is predicted from its language bytes
// and PRs opened; the score it gets decides where it lands, and tomorrow's quotas follow from that.
// `guard`, the measure job's quota check, runs before each core call; when it says stop, discovery ends with what it has.
export type Guard = () => Promise<boolean>;
const always: Guard = async () => true;

// `tracked` holds the ids of every tracked repo, so a renamed one isn't taken again, and the ids taken are added to it.
export async function findGapRepos(gh: GitHub, want: Map<string, number>, tracked: Set<number>, today: string, log: (s: string) => void = () => {}, guard: Guard = always): Promise<Entry[]> {
  const since = addDays(today, -7);
  const out: Entry[] = [];
  const left = new Map(want);
  const languages = [...new Set([...want.keys()].map((k) => k.split(' × ')[1]!))];

  for (const language of languages) {
    const slots = () => [...left].filter(([k]) => k.endsWith(` × ${language}`)).reduce((s, [, n]) => s + n, 0);
    // Each cohort screens up to CANDIDATES_PER_SLOT repos per slot of its own, so one cohort's failures don't use up
    // another's chances.
    const screened = new Map<string, number>();

    const found: Candidate[] = [];
    for (let page = 1; page <= SEARCH_PAGES; page++) {
      let repos: Candidate[];
      try {
        repos = gh.searchRepos(language, since, page);
      } catch (e) {
        log(`gaps: ${language} search page ${page} failed: ${(e as Error).message.split('\n')[0]}`);
        break;
      }
      found.push(...repos);
      if (repos.length < 50) break;
    }
    // One repo can come back on two pages, as pushes reorder the search between them: keep it once.
    const seen = new Set<number>();
    const candidates = found
      .filter((c) => !seen.has(c.id) && (seen.add(c.id), true))
      .filter((c) => !c.fork && !c.archived && !c.private && c.language === language && c.prs > 0 && !tracked.has(c.id))
      .sort((a, b) => b.prs - a.prs || a.repo.localeCompare(b.repo));

    for (const c of candidates) {
      if (slots() === 0) break;
      const lines = Math.round(c.bytes / BYTES_PER_LINE);
      const key = cohortKey(predictSize(lines, c.prs * HEADS_PER_PR), language);
      if (!left.get(key) || (screened.get(key) ?? 0) >= want.get(key)! * CANDIDATES_PER_SLOT) continue;
      if (!(await guard())) {
        log(`gaps: the quota guard stopped discovery, with ${out.length} repos found`);
        return out;
      }
      screened.set(key, (screened.get(key) ?? 0) + 1);
      let runs: number;
      try {
        runs = gh.prRuns(c.repo, since);
      } catch {
        continue;
      }
      if (runs < MIN_PR_RUNS) continue;

      left.set(key, left.get(key)! - 1);
      tracked.add(c.id);
      out.push({ repo: c.repo, reason: 'gap', cohort: key, githubId: c.id, why: `gap ${key}: ~${Math.round(lines / 1000)}k lines, ${c.prs} PRs this week, ${runs} PR runs` });
    }
    const unfilled = slots();
    if (unfilled) log(`gaps: ${language} left ${unfilled} slots unfilled, from ${candidates.length} candidates`);
  }
  return out;
}

// Every tracked repo's GitHub id, looking up and storing those not known yet (a rebuilt loop.db has none).
export function trackedIds(db: DatabaseSync, gh: GitHub): Set<number> {
  const unknown = (db.prepare(`SELECT repo FROM repos WHERE github_id IS NULL`).all() as { repo: string }[]).map((r) => r.repo);
  if (unknown.length) {
    const ids = gh.repoIds(unknown);
    const set = db.prepare(`UPDATE repos SET github_id = ? WHERE repo = ?`);
    for (const [repo, id] of ids) set.run(id, repo);
  }
  return new Set((db.prepare(`SELECT github_id FROM repos WHERE github_id IS NOT NULL`).all() as { github_id: number }[]).map((r) => r.github_id));
}

// The night: refreshes first, then gaps in what's left of `slots`.
export async function planNight(db: DatabaseSync, opts: { today: string; slots: number; gh?: GitHub; log?: (s: string) => void; guard?: Guard }) {
  const refreshes = dueRefreshes(db, opts.today).slice(0, opts.slots);
  const gaps = cohortGaps(db);
  const want = quotas(gaps, opts.slots - refreshes.length);
  const found = opts.gh && want.size ? await findGapRepos(opts.gh, want, trackedIds(db, opts.gh), opts.today, opts.log, opts.guard) : [];
  return { queue: [...refreshes, ...found], refreshes, gaps, quotas: want };
}

export function describe(plan: Awaited<ReturnType<typeof planNight>>): string[] {
  const lines = [`quotas: ${[...plan.quotas].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`];
  for (const e of plan.queue) lines.push(`${e.reason.padEnd(8)} ${e.repo.padEnd(40)} ${e.why}`);
  return lines;
}

if (import.meta.main) {
  const { open, DEFAULT_DB } = await import('./db.ts');
  const { liveGitHub, appToken } = await import('./github.ts');
  const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
  if (!process.argv.includes('--dry-run')) {
    console.error('queue.ts only prints the queue: pass --dry-run. loop/measure.ts runs it.');
    process.exit(2);
  }
  const db = open(arg('--db') ?? DEFAULT_DB);
  const today = new Date().toISOString().slice(0, 10);
  const gh = process.argv.includes('--no-search') ? undefined : liveGitHub(appToken());
  const plan = await planNight(db, { today, slots: Number(arg('--max') ?? 180), gh: gh?.api, log: console.log });
  for (const l of describe(plan)) console.log(l);
  if (gh) console.log(`discovery calls: ${gh.calls.core} core, ${gh.calls.graphql} GraphQL`);
  console.log(`queue: ${plan.queue.length} (${plan.refreshes.length} refreshes, ${plan.queue.length - plan.refreshes.length} gaps)`);
}
