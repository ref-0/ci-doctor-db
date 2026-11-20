# Proposals

The ledger the Sunday optimize step picks from: at most 3 a week, by expected effect on the one metric or on trust in the score. The learn job adds entries from each digest; a person or the EM changes their status.

## Format

Each entry is a heading `P-NNN · <status>`, then:
- **Date:** when it was proposed, YYYY-MM-DD.
- **Change:** one line, what to change.
- **Evidence:** a line from a digest, quoted with its file, or a dated doc when no digest measures it yet.
- **Lands:** one of scorer, calibration, guide, skill, site.

Status is `open` (not started), `briefed` (an engineer has a brief), `done` (merged; name the PR) or `dropped` (say why in one line). Ids never get reused. Entries stay in the file once done or dropped.

## Entries

### P-001 · open
- **Date:** 2026-11-19
- **Change:** Read plain `cargo test` output: each test binary's `test result: … finished in N s` line, as nextest's per-test lines are read now.
- **Evidence:** `digest/2026-11-19.md`: "By test runner: … nextest 10/15" and "By language: … Rust 14/33", so 4 of the 18 Rust repos without nextest have timings.
- **Lands:** scorer

### P-002 · done
- **Date:** 2026-11-19
- **Change:** Read `go test` output. Already done: `score.ts` reads its `ok  <pkg>  N s` lines, per package. `FINDINGS.md` §1 predates that parser.
- **Evidence:** `digest/2026-11-19.md`: "By language: … Go 12/14".
- **Lands:** scorer

### P-003 · open
- **Date:** 2026-11-19
- **Change:** Page past the runs list's 1,000-run cap by time window (`created=` ranges), so a busy repo's window covers its 7 days.
- **Evidence:** `digest/2026-11-19.md`: "Windows: 97 of 219 hit the 1,000-run cap; 76 cover under 3 days and 32 under 1".
- **Lands:** scorer

### P-004 · open
- **Date:** 2026-11-19
- **Change:** Re-score every stored report with bot PR runs (Dependabot, Renovate) left out of the wait, and keep it only if separation holds.
- **Evidence:** `digest/2026-11-19.md`: "Bot share of PR runs: p10 / p50 / p90 0% / 7% / 34% (n 219), counted in every score".
- **Lands:** calibration

### P-005 · open
- **Date:** 2026-11-19
- **Change:** Store per-job results for the sampled runs (name, conclusion, required or not), so a red main can be traced to a job.
- **Evidence:** no digest measure yet. `FINDINGS.md` §1, 19 Nov: vite's 17 red main commits couldn't be tied to required checks without per-job results.
- **Lands:** scorer

### P-006 · open
- **Date:** 2026-11-19
- **Change:** Detect the test runner for the repos where none is found: `cargo test`, `go test`, plain `pytest`, and Node's own runners, read from workflows and manifests.
- **Evidence:** `digest/2026-11-19.md`: "No test runner detected: 125 of 219 scored repos: 34 × TypeScript, 18 × Python, 17 × Rust, 14 × Go".
- **Lands:** scorer

### P-007 · open
- **Date:** 2026-11-19
- **Change:** Name the providers behind the runner labels the scorer passes through raw, starting with `xcode-*`, or count them as "other" so they don't show as providers.
- **Evidence:** `digest/2026-11-19.md`: "Runner labels not recognised: `xcode-27` (4), …", 10 labels in all.
- **Lands:** scorer

### P-008 · open
- **Date:** 2026-11-19
- **Change:** Give repos with too few PR pushes in 7 days a longer window (14, then 28 days) before calling them unscored.
- **Evidence:** `digest/2026-11-19.md`: "Unscored: 24 (24 × Only N PR pushes in the window ran the main workflows; N are needed.)".
- **Lands:** scorer

### P-009 · open
- **Date:** 2026-11-19
- **Change:** Compare practice effects on wait for size (wait ÷ the size curve), not raw wait, within each cohort: several effects point backwards, as `FINDINGS.md` §3 saw across all repos.
- **Evidence:** `digest/2026-11-19.md`: "medium × TypeScript (28) | frozen_install | 23.3 (21) | 6.8 (7) | 3.43" and "large × Rust (22) | compiler_cache | 27 (16) | 14.3 (6) | 1.89".
- **Lands:** calibration

### P-010 · done (ci-doctor#5)
- **Date:** 2026-11-19
- **Change:** Read each workflow's job graph (`needs:`, reusable workflows, and wait actions where named) and compute, per PR run: the critical path through the graph, each job's **blocked** time (from its creation until its last `needs` finished) apart from its **queue** time (until a runner took it), and the job that blocks the most downstream minutes. Report "the chain that sets the wait" and "the top blocker", and add both to the `<ci-report>` block.
- **Evidence:** today the scorer takes "the critical job" as whichever job finished last (`score.ts` jobs section) and never reads `needs:`, so it can't tell a slow job from one waiting on another. Guide sections 1, 3 and 7 tell agents to name the critical path, and Phase 2 measures it by hand. Raised by the maintainers, 19 Nov.
- **Lands:** scorer, then site (the replay view, SITE.md section 6)

### P-011 · done (ci-doctor#4)
- **Date:** 2026-11-19
- **Change:** Read a JavaScript or TypeScript workspace's package graph from its manifests: packages, internal dependency edges, depth, fan-in, cycles, and each package's `exports` map (present, source-first condition, barrel entries). Record it in the report's stack, and flag what widens selection or slows checks: a cycle, a package most of the workspace depends on, a barrel entry, a package with no `exports`.
- **Evidence:** the scorer counts packages and nothing more. Guide section 4 (a selector from the real dependency graph, fan-in, package entry points) and section 9 (boundaries, the export guard, source-first exports) depend on this graph, and Phase 1 maps it by hand. Raised by the maintainers, 19 Nov.
- **Lands:** scorer, then guide

### P-012 · done (ci-doctor#3)
- **Date:** 2026-11-19
- **Change:** A guide section, and a `ci-doctor` topic, on the package graph as a checked contract: declared layers, which entries of each package another may import, nothing imports an app, enforced by a lint rule, and what it buys CI (narrower selection, cache keys that don't change for unrelated edits, a type check that stays per project). Source: the monorepo's package-graph lint, at sync.
- **Evidence:** guide section 9 names "no forbidden layer imports" in one bullet; there's no section on designing or checking the graph. Raised by the maintainers, 19 Nov.
- **Lands:** guide, skill

### P-013 · done (ci-doctor#7)
- **Date:** 2026-11-19
- **Change:** A local tool, `scripts/graph/` in ci-doctor, that an agent runs in a repo: the workspace's package and file import graph through `exports`, fan-in, cycles, barrels, folder-level layers, and, replaying recent commits, what each change triggers as a share of the workspace.
- **Evidence:** the scorer only sees manifests from outside; the import graph and "what triggers what" need the source. Guide section 4 depends on them, and Phase 1 maps them by hand. Raised by the maintainers, 19 Nov, as very high priority.
- **Lands:** scripts, skill

### P-014 · open
- **Date:** 2026-11-19
- **Change:** The scorer fetches each workspace package's `exports` entry files by raw fetch and measures export-path overload: `export *`, re-exported module counts, root barrels, and overload = re-exported modules × importing packages. Shown on the report's graphs (SITE.md 7b) and in the `<ci-report>` block.
- **Evidence:** an overloaded export path can make one edit invalidate most of a workspace's affected checks and caches; the maintainers saw it in the monorepo. Raised 19 Nov.
- **Lands:** scorer, site

### P-015 · done (ci-doctor#6)
- **Date:** 2026-11-19
- **Change:** Add the coverage audit's general techniques to the guide and skills: startup work and startup gates, per-phase harness timing, fixture CPU profiling, immutable prerequisites with fresh mutable state, batched fixtures with equivalence checks, immutable build snapshots, capture and replay, completion predicates, first-pass vs replay waits, and the flake cases (executable descriptors, Git maintenance, socket paths, parent pipes, refused bodies, isolated sparse checkouts, installer logs).
- **Evidence:** a full audit of the monorepo's 14,412 commits against the guide found 17 techniques that moved CI time or flake rate and that the guide doesn't teach or teaches only in passing. The report stays on the maintainers' machine (`ci-gist/build/COVERAGE-AUDIT.md`).
- **Lands:** guide sections 2, 5, 8, 10 and 11; the Workers, flake and triage skill topics
