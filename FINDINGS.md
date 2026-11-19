# What we learned scoring 219 repos

Measured 18–19 Nov 2026 from GitHub's API: each repo's PR runs over its last 7 days (or its last 1,000 runs, whichever is shorter), its main branch, a sample of jobs and 1–3 job logs. Scores are the calibrated ones ([calibration.md](calibration.md)). 219 repos scored; 24 more had too few PR runs to score. Comparisons between practices are correlations across repos, not causes.

## 1. The probe

**What held up:**
- **Our PR wait matches outside measurements.** For 103 repos the research list had its own median for the main workflow. Ours is within 2× of it for 88, and the median ratio is 1.04. The 15 that disagree mostly measured a different workflow, such as one that waits on a deploy.
- **Lines of code from the tree.** Counting code-file bytes in the Git tree, without vendored, generated and build folders and files over 1 MB, gave lines for 214 of 219 repos. GitHub's language totals count vendored copies: t3code read 7.3M from its `.repos` folder and is 2.65M, php-src 4.0M and is 1.46M.
- **Cost.** A repo takes a median of 28 API calls and 58 at the 90th percentile, so the App's 5,000 an hour covers about 170 checks an hour.

**What's weak:**
- **The 1,000-run cap.** GitHub's runs list stops at 1,000. 97 of 219 windows hit it, 76 cover under 3 days and 32 under 1, so busy repos are judged on a day or two, and a weekend or a bad afternoon moves their score.
- **Test timings.** We read job logs for 217 repos but found per-file timings in only 85 (39%). The parser reads Vitest, Jest, nextest and `pytest --durations`. Plain `cargo test`, `go test`, XCTest and JUnit output aren't read, which covers most of the Rust, Go, Swift and JVM repos.
- **Jobs aren't kept per job.** We couldn't tell whether vite's red main runs (17 red commits, all from its main `CI` workflow) come from required checks, because per-job results aren't stored.
- **Private repos.** Workflows and manifests come from `raw.githubusercontent.com`, which can't read private repos, and a failed read looks like a missing practice. The local scorer needs authenticated reads (see `../ci-gist/SKILLS-PLAN.md`).
- **Bots.** A median 7% of PR runs come from bots (Dependabot, Renovate). They're counted today. Worth testing whether leaving them out changes any score.

## 2. The scoring

- **Labels from practices aren't speed labels.** The research list's "well-run" slice (38 repos) was picked for good techniques: Blacksmith, Bazel caches, affected selection, shards. rust-lang/rust waits 77 min and airflow 115. Under the calibrated scores that slice's median is 65. Good practice and short waits are different things, and the score measures the wait.
- **Size explains little.** Lines of code explain 12% of the variation in wait (log–log r² 0.12), with wait growing about as lines^0.23. Job minutes per merged PR grow as lines^0.33, also r² 0.12. The size adjustment stays, at a modest weight. Language and stack probably explain more; untested.
- **Failing PR runs measure people, not CI.** People push failing work in progress, so red PR heads came out of reliability. Main's red rate and green-only-on-rerun stay.
- **Slow outliers.** 12 repos have a p90 wait over 10× their median, which looks like waits outside CI, such as approvals or manual dispatches (a guess). The p90's weight went from 15 to 5.
- **The result:** 91% of trusted fast repos score 75 or more, and 89% of trusted slow ones under 50, up from 77% and 61%. About 7 settings were tuned against 40 labels; the hold-out half held up but has only 6 slow repos.
- **The spread:** 67 repos at 75 or more, 82 at 50–74, 70 under 50. No repo with a median wait of 5 min or less scores under 60, and none at 20 min or more reaches 75.

**Across all 219:**

| Measure | p10 | Median | p90 |
| --- | --- | --- | --- |
| PR wait, median (min) | 4.0 | 17.1 | 52.7 |
| p90 ÷ median wait | 1.15 | 1.48 | 3.87 |
| Main branch red | 0% | 6% | 50% |
| PR heads green only on a rerun | 0% | 1% | 5% |
| Runner queue at p90 (s) | 2 | 4 | 596 |
| Setup share of job time | 3% | 15% | 42% |
| Runs per merged PR | 4.2 | 16.6 | 77.8 |
| Test share of job time | 13% | 41% | 61% |

## 3. Practices against wait for size

Each repo's median wait divided by what its size predicts; lower is faster. Correlations only.

| Practice | With (repos) | Without (repos) | Reads as |
| --- | --- | --- | --- |
| Dependency cache | 0.95 (175) | 1.32 (38) | The clearest gap: repos with no dependency cache wait about 40% longer for their size |
| Fast linter (Oxlint, Biome, Ruff) | 0.83 (58) | 1.05 (155) | Likely a marker of repos that care about tool speed generally |
| Affected selection | 0.85 (14) | 0.98 (199) | Helps, but only 14 repos do it |
| Skip drafts | 0.91 (72) | 0.98 (141) | Small |
| Merge queue | 0.92 (64) | 0.98 (149) | Small |
| Compiler cache (sccache, ccache) | 1.23 (49) | 0.93 (164) | Backwards: compiled-language repos are slower for their line count, and they're the ones with compiler caches. Lines don't capture build cost |
| Job timeouts, cancel superseded runs | 0.99, 0.98 | 0.80, 0.86 | Backwards too: small, simple repos often set neither |

**Stacks:** 100 repos are TypeScript, 31 Rust, 22 Python, 14 Go, then Swift, Elixir and Ruby at 6 each. 169 have no task runner we detect; 31 use Turborepo, 9 Nx, 3 Bazel. 188 run on GitHub-hosted runners; 7 on Blacksmith, 5 on Namespace.

## 4. Gaps in ci-doctor

**What repos need that the playbook is thin on:**
- **Stacks beyond TypeScript and Rust.** The guide has pages for Rust, Cloudflare Workers and Effect. Python, Go, the JVM and Swift (macOS runners, Xcode) have none, and they're over a third of the repos. The selection planner assumes a pnpm workspace.
- **Turborepo and Nx.** 40 repos use one, and the selection planner can't read either. Guide section 6 covers their caches only.
- **Dependency caching as fix number one.** The largest correlation in the data, and setup is 42% of job time at the 90th percentile. The guide treats it inside section 6's broader reuse; a short first-fix page would match how often it's the problem.
- **Runner queues.** One repo in ten waits about 10 min for a runner at p90. Concurrency limits on GitHub-hosted plans, and when a queue is the bottleneck rather than the tests, have no section.
- **Run fan-out.** A median 16.6 runs per merged PR, and 78 at p90: many workflows, every push. Cancelling superseded runs is covered; consolidating workflows and trimming triggers isn't.
- **Test records for non-Vitest runners.** Guide section 13 and the records scripts are Vitest and pytest. `go test`, `cargo test`, JUnit and XCTest need readers, the same gap as the probe's.

**What the report recommends that may not earn its place:**
- **"No AGENTS.md" is the most common fix (50 repos).** It's ci-doctor's own way of working, not a CI problem the data shows. It should drop out of the score report's fixes, or move to a separate "for agents" note.
- **"Move broad checks to a scheduled sweep" (43) and "run only what a change can reach" (48)** are right for big monorepos, but they come up for medium repos too. Tie them to size and measured test time.

## 5. What to do next

1. **Probe:** page past the 1,000-run cap by time window for busy repos, store per-job results, and add `go test`, `cargo test`, JUnit and XCTest log readers.
2. **Score:** test leaving bot runs out, and try language or stack in the size adjustment.
3. **ci-doctor:** a dependency-caching first-fix page, Python and Go pages, Turborepo and Nx readers in the selection planner, and the fixes list tied to size.
