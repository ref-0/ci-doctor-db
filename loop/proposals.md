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
