# CI score: the first idea notes (18 Nov 2026)

A small public site. Someone pastes a GitHub repo and gets a quick automated CI report: a score, PR wait percentiles, and what to fix. It has a share card for X, a GitHub link to ci-doctor, and a copyable ci-doctor prompt. People post their times to brag, or to be sad. It promotes ci-doctor.

**Status:** an idea with a working scorer, `score.ts` (v0, 18 Nov; it replaced the first `probe.ts`). A list of 100 repos was assembled to calibrate on. The aim is that well-run repos get good scores.

## The shape, from similar tools

| Tool | What it does | What to take |
|---|---|---|
| [React Doctor](https://react.doctor) ([repo](https://github.com/millionco/react-doctor)) | `npx react-doctor@latest`; a 0–100 score with diagnostics; a share URL | One command, one number, a share link |
| [IsAgentReady](https://isagentready.com) | Paste a URL; weighted categories; a public rankings page; an MCP server | Weighted categories, rankings |
| [CommitScore](https://commitscore.dev/) | "Your dev year as a shareable receipt"; a leaderboard with language tabs | The receipt framing, leaderboard filters |
| Gityap ([HN](https://news.ycombinator.com/item?id=47024218)) | GitHub commits against Telegram posts gives a ship-to-talk ratio | The playful framing. I couldn't find the "shipper or yapper" X post itself |

All of them use the same pattern: one input, one big number, a few categories, a share card, and a leaderboard.

## Site sketch

The full design, with mock-ups agreed 18 Nov, is in [SITE.md](SITE.md). It's built with ref0's component library.


- Minimal: one input (`owner/repo`; a username can resolve to that user's most active repos with CI), one report page per repo at a stable URL, and an OG image per report.
- shadcn, or pieces ported from ref0's component library.
- On every report: a GitHub logo linking to ci-doctor, and the copyable prompt (ci-doctor's AI Quickstart prompt, then the report).
- Cache each repo's report for 24 h.
  - One token allows about 160 reports an hour, at about 30 API calls each.
  - Queue the rest, or let people sign in with GitHub so their own quota is used.

## What public GitHub data gives (with any token)

- **The run list** (1 call per 100 runs): PR wait percentiles, red-head rate, rerun rate, which workflows run on PRs, push vs PR timings, runs per day.
- **Jobs** (1 call per run; sample about 10). These include each step's timing, so you get:
  - queue time;
  - the runner provider, read from labels;
  - job minutes, and minutes rounded up per job, which gives a list-price cost estimate;
  - setup's share against the real work;
  - the longest job.
- **Workflow files and the repo tree** (one recursive tree call, plus `package.json`): the static practices listed below.
- **PRs:** time from opening to merge, and time spent in draft.
- **Other CI** (CircleCI, Buildkite): only start and end times, through the checks on each commit.
- **Not available:**
  - the real bill (public repos run free on GitHub-hosted runners, so cost is "at list price");
  - test-level timings and flakes, which need log downloads (out of v1);
  - private repos, unless someone signs in.

## Tokens and rate limits

Checked 18 Nov 2026:
- With no token, GitHub allows 60 calls an hour per IP, and job logs return 403 even on public repos. So every report needs some token.
- With a token, a user gets 5,000 calls an hour. A GitHub App installed on our own org gets 5,000 to 12,500 an hour. Spreading load over several accounts or tokens to get around the limits is against GitHub's terms.
- A report costs about 30 calls, or about 40 once logs are read. One token covers about 150 new reports an hour.

The plan:
1. **One shared cached report per repo.** Going viral mostly means many people viewing the same popular repos, and those views cost nothing. Only a repo nobody has asked about in 24 h costs calls. Refresh with ETags, because a 304 doesn't count against the limit.
2. **Precompute the leaderboard offline**: the 100 calibration repos, then the top ~1,000.
3. **Our GitHub App's token handles new repos while it has quota left.**
4. **When it runs out, show "Sign in with GitHub to run it now"**, or offer a place in the queue. Sign-in uses OAuth with no scopes, which is enough for public data. The report then spends the visitor's own 5,000 calls. Nobody pastes a token.
5. **Keep every report, dated.** Serve the newest one for 24 h. The older ones give each repo a history, so people can post a before-and-after once ci-doctor's fixes land.
6. **Private repos are out of v1.** They need the `repo` scope, which is a scary ask for a share-your-score site.

## The copyable prompt carries the report

Agreed 18 Nov. The prompt people copy carries their report, so their agent knows the state of things before it clones ci-doctor:

```text
<the ci-doctor README's AI Quickstart prompt> Start from this CI report:

<ci-report repo="owner/repo" date="2026-11-18" url="https://…/owner/repo.md">
Score 41/100 (slower than 72% of repos this size)
PR wait p50 / p75 / p90: 23.8 / 28.3 / 34.4 min · queue p90 0.4 min · red heads 19% · reruns 4%
Critical path: "test prod" (10 shards, slowest shard 1.32× the median, 22% idle tail)
Slowest test files: …
Fix first: 1. … (guide 07)  2. … (guide 04)  3. … (guide 06)
</ci-report>
```

- Inline only the summary: the numbers, the top 3 to 5 fixes with their guide pages, and the slowest files. Keep it short enough to paste. Link the full report as Markdown at a stable URL, and serve JSON beside it for agents.
- **A change to ci-doctor's side** (*done 19 Nov, in Phase 2 of the `ci-doctor` skill*): the measuring phase takes a `<ci-report>` as its starting point. It treats the report as dated public data: the agent checks it against the repo's own runs instead of trusting it, but skips re-deriving what the report already settled. It also tells the agent the report's guide links map to `docs/`.
- After the fixes, the before-and-after report history (see "Tokens and rate limits", step 5) closes the loop: run it again, then post it.

## Probe results, 18 Nov 2026

From the newest ~300 PR workflow runs per repo, read that day.

| Repo | PR wait p50 / p75 / p90 (min) | Red heads | Reruns | Runners | API calls |
|---|---|---|---|---|---|
| honojs/hono | 1.8 / 2.0 / 3.0 | 12% | 16% | GitHub-hosted | 10 |
| facebook/react | 8.3 / 9.9 / 12.0 | 10% | 5% | `ubuntu-latest` | 29 |
| astral-sh/ruff | 13.9 / 19.3 / 19.9 | 9% | 10% | Depot, 4 vCPU | 29 |
| vercel/next.js | 23.8 / 28.3 / 34.4 | 19% | 4% | `ubuntu-latest` + 16-core | 29 |

"Wait" means: for each PR head, the time from the first workflow starting to the last one finishing.

What the first probe got wrong (all fixed in `score.ts`):
- **Use a 7-day window, not a run count.** On busy repos, 300 runs is less than a day. Cap it at about 1,000 runs, which is about 10 calls.
- **Sample jobs from the workflow that finishes last, not the busiest one.** The busiest picked ruff's `Release` dry-run and hono's `cr`.
- **Compare repos of similar size**, using runs per day and contributors. next.js is slow because it's enormous.

## Signals to collect, mapped to ci-doctor's guide

### A. Outcomes, measured from runs (most of the score)

| Signal | How | Good looks like | Guide |
|---|---|---|---|
| PR wait p50 / p75 / p90 | First workflow start to last finish, per PR head | Short and tight, with p90 under 2× p50 | 01 |
| Main-branch wait | The same, for pushes to main | Short; broad checks run on a schedule | 05 |
| Queue time p90 | Each job's creation to its start | Seconds | 02, 07 |
| Setup share | Step timings: checkout, install and setup against the work | Small | 06 |
| Minute-rounding waste | Minutes rounded up per job, against actual minutes | Few jobs under a minute | 07 |
| Critical-path job | The job that ends last, and its share of the wait | No single job dominates | 07, 10 |
| Red-head rate | PR heads with any failed check | Low | 11 |
| Flake proxy | The same commit failed, then passed on a rerun | Near zero | 11 |
| Main red rate | Failing main pushes, and how long main stays red | Rare, fixed fast | 05 |
| Wasted runs | Cancelled or superseded runs; runs on drafts | Old runs cancelled; drafts run nothing | 04 |

### B. Running less

- Path filters on PR workflows (`paths:`, `paths-ignore:`, `dorny/paths-filter`, `tj-actions/changed-files`).
- Selection by what the change affects (`turbo --affected`, `--filter=...[origin/main]`, `nx affected`, `vitest --changed`, Bazel target diffing).
- `concurrency` with `cancel-in-progress` on PR workflows.
- Drafts skip CI (`draft == false`, or `ready_for_review` in the trigger types).
- Heavy jobs kept off ordinary PRs. Flag macOS, Windows, end-to-end and matrix-explosion jobs on `pull_request`.
- A scheduled sweep (`schedule:` running broad tests).
- A merge queue (`merge_group`).
- One required gate job (a final `needs: [...]` job with `if: always()`).

### C. Reusing work

- A dependency cache (`setup-node` `cache:`, `actions/cache` keyed on the lockfile, the pnpm store, `uv`/pip).
- A remote task cache:
  - `TURBO_TOKEN`/`TURBO_TEAM`;
  - Nx Cloud;
  - Vite+'s remote cache;
  - Bazel `--remote_cache`;
  - Gradle's build cache.
- A compiler cache (`Swatinem/rust-cache`, sccache, ccache).
- A Docker layer cache (`cache-from: type=gha` or a registry).
- Build once and share the output. Flag several jobs each running the same build.
- Frozen installs (`--frozen-lockfile`, `npm ci`, `--locked`).

### D. Shards and runners

- Tests split into shards (`--shard`, a matrix of shard indexes), and balanced by measured time (`split-tests --timings`, Knapsack).
- The runner provider, from labels: GitHub-hosted, larger runners, Blacksmith, Depot, Namespace, BuildJet, Warp, Ubicloud, RunsOn, self-hosted. Arm, from `-arm` labels.
- `timeout-minutes` on each job.
- Many tiny jobs: the job count per run against median job length (the billing cliff).
- `fail-fast` on test matrices.

### E. Workspace tooling

- The task runner: `turbo.json`, `nx.json`, Vite+ tasks, `MODULE.bazel`, `moon.yml`, `pants.toml`.
- The package manager: pnpm, bun, Yarn Berry, npm.
- Fast linting: Oxlint or Biome, against ESLint only.
- Fast type checking: TypeScript 7 native, tsgo or tsrs, against `tsc`; `composite` or `incremental` in tsconfig.
- A fast test runner: Vitest or Bun's against Jest; `cargo-nextest`; pytest-xdist.
- Fast builds: esbuild, SWC, Rolldown, Rspack; `uv`; the mold linker.
- Duplicate passes: type checking or the build running in more than one job.

### F. Tests and flakes

- Retries configured (Vitest `retry`, Jest `retryTimes`, Playwright `retries`). Flag it unless recoveries are recorded.
- Flakes tracked: a flake bot, quarantine lists, test-result uploads (JUnit, BuildPulse, Trunk).
- End-to-end tests on every PR across a full browser matrix.

### G. Health and guardrails

- A scheduled CI health or budget workflow.
- Dependency bots batched (Renovate `groupName` and `schedule`, Dependabot `groups`).
- Bots' share of CI runs.

### H. Ready for agents

- `AGENTS.md`, `CLAUDE.md` or `.cursor/rules` exists, and names a narrow test command.
- Skills folders (`.agents/skills`, `.claude/skills`).
- The `AGENTS.md` size.
- Fast checks before pushing (lefthook, husky, `pre-commit`).

## Scoring

- **Section A sets about 70% of the score; sections B–H at most 30%.** Sections B–H are mainly the "what to fix" list, each item linking to its guide page, then to the ci-doctor prompt.
- **Practices count only where the outcome is bad.** For example, "no remote cache, and setup plus build is 60% of the wait". Small fast repos stay on top, and adding YAML can't game the score.
- **Rank against repos of similar size.** That gives "faster than N% of repos your size", which is more shareable than a raw rank.

## The scorer, v0 (18 Nov 2026)

This research scorer, `score.ts`, is retired: the published one in ci-doctor (`scorer/`, `@ref0/ci-doctor`) holds every field it had, and more. `GH_TOKEN=$(node token.ts) node score-repos.ts owner/repo [...]` scores with it, through `scorer.ts`, and writes `reports/<owner>__<repo>/<date>.json`. What follows describes v0 as it was on 18 Nov.

What it reads, in about 10 to 45 API calls a repo:
- **Runs:** up to 1,000 from the last 7 days. On busy repos that's only 0.4 to 1.5 days.
- **The first attempt of up to 25 rerun runs.** "Green only on rerun" counts only a failed first attempt followed by a passing rerun.
- **Jobs** from 6 green runs of the workflow that most often finishes last. From these: queue time, setup share (by step name), the longest job, the run's span, billing, the runner provider, and shard spread (jobs whose names differ only by `N/M` or `shard N`).
- **Logs** of up to 3 jobs: the jobs with the longest test steps, and the slowest shard. From these, the slowest tests, parsed from Vitest, Jest, Go, nextest and pytest `--durations` output.
- **The tree and workflow files,** for the practices in sections B to H.

**The profile** comes first in every report: what the repo is, before how its CI does. It costs about 4 to 9 API calls and 2 search calls. The OpenClaw article broke the same things down (`~/ref0-work/ci-gist/research/openclaw/article/numbers.md`): source lines as tests, integration tests, support and implementation; runs per merged PR; and opened-to-merged time.
- **Code:**
  - lines of code: GitHub's language bytes ÷ 30, which was within 10% of real line counts on hono, vite and ruff;
  - top languages, files and source files;
  - source split into implementation, tests, named integration/e2e tests and support (fixtures, mocks, snapshots), by path and file size from the tree;
  - packages: npm, crates, Go modules and Python projects, leaving out examples and fixtures.
- **Pace:**
  - commits a week on the default branch, and the people who wrote them, over the last 28 days;
  - the last month's commits a week against the year's average;
  - repo age, stars and forks.
- **PRs:**
  - opened and merged a week;
  - the bots' share of merged PRs;
  - people's opened-to-merged p50 and p90 (bots' PRs merge in minutes and would skew it);
  - PR runs per merged PR.
- **Caveats:**
  - Rust tests inside source files count as implementation, so Rust repos show a low test share;
  - a truncated tree (very big repos) undercounts;
  - PR timing uses at most 100 merged PRs.
- **The size class** is the larger of two: by code (20k / 200k / 1M lines) and by PR pushes a week (10 / 50 / 250).

Profiles from the first runs:

| Repo | Lines | Tests share | Packages | Commits/week (people) | PRs merged/week | PR runs per merged PR |
|---|---|---|---|---|---|---|
| hono | 99k | 69% | 9 npm | 14.8 (14) | 22, 73% bots | 4.2 |
| vite | 121k | 36% | 30 npm | 31.8 (29) | 56 | 13.9 |
| react | 384k | 44% | 63 npm, 14 crates | 15.5 (19) | 35 | 97.1 |
| ruff | 1.0M | 13% (inline Rust tests uncounted) | 57 crates, 33 Python | 124.5 (47) | 165 | 22.3 |
| biome | 1.3M | 18% | 112 crates, 22 npm | 108 (33) | 119 | 57.3 |
| next.js | 2.8M | 29% | 274 npm, 73 crates | ≥125 (≥41) | 184 | 21.6 |

The score (agreed 18 Nov): one number out of 100 from three parts. Each part is scored 0–100 from whichever of its measures could be read.
- **Speed, 50:**
  - p50 wait against a fixed scale, 20 (2 min is full marks, 40 min is zero, on a log scale);
  - p50 wait against what's expected for the repo's size, 15 (half the expectation is full marks, 2.5× is zero);
  - p90 wait, 15.
- **Reliability, 30:** green only on rerun 14, main red (leaving out workflows that don't gate a merge) 10, red PR heads 6.
- **Efficiency, 20:**
  - PR CI job-minutes per merged PR against what's expected for the size, 6. It's measured across every PR workflow: 2 sampled runs each, scaled by run count, with cancelled runs at half;
  - PR runs per merged PR, 4;
  - setup share, 4;
  - queue p90, 3;
  - shard idle tail, 3.
- **Practices aren't scored.** They only produce fixes when an outcome is bad.
- **The repo profile** (lines, pace, PRs) sets what's expected for its size; test share, opened-to-merged time and bot share are context only.
- **The two size expectations are placeholders** until the 100-repo fit: expected p50 = 5 min × √(lines / 100k), at least 2; expected job-min per merged PR = 60 × √(lines / 100k), at least 10.

Scores after the restructure, 18 Nov:

| Repo | Score | Speed | Reliability | Efficiency | Why |
|---|---|---|---|---|---|
| hono | 76 | 100 | 32 | 82 | fast, but 21% of PR heads green only on rerun and main red 22% |
| ruff | 61 | 34 | 89 | 84 | slow for its size; reliable |
| vite | 56 | 68 | 16 | 84 | main red 57%: Windows "Test serve" failing |
| biome | 55 | 32 | 91 | 57 | 22-minute unsharded job |
| react | 46 | 51 | 53 | 22 | ~6,000 PR job-min per merged PR (~20 pushes × ~300 job-min) |
| next.js | 31 | 27 | 47 | 17 | ~3,900 PR job-min per merged PR; setup 71% |

These weights and bounds are guesses until the 100-repo run.

First results, 18 Nov:

| Repo | Score | PR wait p50 / p90 | Findings |
|---|---|---|---|
| honojs/hono | 85 | 1.8 / 1.9 | 21% of heads green only on rerun; slowest file 5 s |
| vitejs/vite | 73 | 4.9 / 7.4 | 61% of heads red; macOS matrix job is the longest |
| astral-sh/ruff | 61 | 19.1 / 20.8 | benchmark chain sets the wait; snippet example tests 40–50 s |
| biomejs/biome | 56 | 21.1 / 23.9 | one 22-minute Node.js API job, unsharded |
| facebook/react | 50 | 8.2 / 23.6 | p75 jumps to 23; queue p90 3 min; setup 45%; shards 1.30× |
| vercel/next.js | 30 | 26.8 / 37.5 | setup 71%; shards 1.46×, 28% idle; miri tests up to 20 min |

The ranking looks right. Known gaps:
- **Size:** big repos lose points for being big. Percentiles by size class need the 100 repos.
- **Wait:** it includes time a run waits for a concurrency group, which is real wait. It also includes workflows that don't gate a merge, unless their name matches the `NOT_A_CHECK` list. Required checks aren't public.
- **Setup and test detection:** both work from step names, so they're heuristics.
- **Quota:** the token is shared with other work, so watch `gh api rate_limit` before a big batch.

## Next

1. Done: `score.ts` v0, above.
2. Run it on the 100 calibration repos, and check the ranking looks right before any site work.
3. Build the site with `@ref0/ui`, as [SITE.md](SITE.md) lays out: OG cards (concept still open), the copyable prompt carrying the report, dated report history and the offline leaderboard.
4. In ci-doctor, have the `ci-doctor` skill accept a `<ci-report>` block. *Done 19 Nov, in Phase 2.*
5. Track every checked repo, detect who adopted ci-doctor, and show their improvement ([SITE.md](SITE.md#tracking-repos-adoption-and-improvement)). ci-doctor's prompt needs to leave an open marker.
6. Launch on X, inspired by React Doctor's post. The plan and a first draft are in [LAUNCH.md](LAUNCH.md).
