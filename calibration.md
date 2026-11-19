# Calibration, 19 Nov 2026

**Ported 19 Nov.** `score.ts` now uses CALIBRATED. `node rescore-local.ts` re-scored the newest report of all 219 scored repos from their stored inputs, with no API calls, and left 24 unscored ones alone. Each re-score went to a new `<date>_rescored.json` beside the original, so the old score stays as history, and the new file sorts after it so readers take it. Each one records `rescored.scoreWas`. A check of `score.ts` against `calibrate.py`'s CALIBRATED gives zero diffs on 219 repos. The log is in `rescore-local.log`.

Final named scores, stored score → ported score: t3code 97→98, oxc 89→89, hono 74→79, vite 55→78, ruff 61→66, react 46→64, biome 55→63, next.js 37→42, aspire 37→34. Stored scores differ from this file's BASE column because 9 or more reports carried an older `scoreOf`. All are re-scored now.

The 214 labelled reports, plus 5 unlabelled ones checked by name, give 219 scored reports, all re-scored 18–19 Nov. They're scored again offline from their stored inputs by `calibrate.py`, which now mirrors `scoreOf` in `score.ts`. Nothing was fetched from GitHub.

Reproduce from `~/ref0-work/ci-score`:
- `python3 -I calibration/cands.py` scores the candidate configs against the trusted labels.
- `python3 -I calibration/grid.py` runs the grid search.
- `python3 -I calibrate.py inbox/repos.csv inbox/research.csv` prints BASE against CALIBRATED over every label, the distrusted ones included.

## The labels: what I trust

`inbox/research.csv` has 127 labelled repos in three slices. Each label has a "why" sentence, and I judged each one from that.

**Distrusted: the `well-run` slice (38 scored, all labelled fast) and 6 single labels (1 fast, 5 slow):**

| Repos | Why I distrust the label |
| --- | --- |
| Slice `well-run`, 38 scored, all labelled fast | The label comes from practices (Blacksmith, Bazel cache, affected selection, shards), not from a measured wait. rust-lang/rust (77 min), apache/airflow (115), rustfs (84), microsoft/playwright (37), bevy (33), cpython (37), uv (21) and vitest (13) are all here. "Uses good techniques" is not the same as "is fast": under the chosen config this slice's median is 65. |
| elixir-lang/elixir | The label's own sample says a ~9 min median; ours is 24.4. They measured a different workflow or sample. |
| symfony/symfony | The label says ~34 min; ours is 9.0. |
| godotengine/godot | The label says ~89 min; ours is 17.1. |
| tox-dev/pre-commit-uv | "15+ min runs"; our p50 is 4.0. |
| feernandooff/kinuvo | "Slow" with a ~10 min median at 212k lines, and the why gives no reason. |
| functionalscript/functionalscript | "Slow" at 18 min with 616k lines, about where the size curve puts a typical repo. Ambiguous. |

**Reported apart, labelled slow for failing runs (10):** apollooffice, beads, decaf, pytest-asyncio, swift-log, inih, go-sql-driver/mysql, swift-http-types, cxxopts and botore. Their whys are "N of M runs failed". That is a claim about reliability, or simply failing code, not about waiting, so they aren't held to "slow <50". Their median score goes from 59 to 62.

**Trusted: 22 fast and 18 slow, all scored.** These come from the `breadth` and `agents-and-small` slices, where the label rests on a sampled median wait that agrees with ours within 2×.
- **The fast set leans small.** 9 of the 22 are under 20k lines and under 2 min, so they pass under any config. The ones that discriminate are the mid-size fast repos: terraform, cli/cli, detekt, curl, SDL, laravel, jellyfin, ash, blockscout and plausible.

## The chosen config: CALIBRATED (D6)

| | BASE (now in `score.ts`) | CALIBRATED |
| --- | --- | --- |
| Part weights, speed / reliability / efficiency | 50 / 30 / 20 | **60 / 20 / 20** |
| Speed: wait / for size / tail | 20 / 15 / 15 | 20 / 15 / **5** |
| Reliability: flakes / main red / red PR heads | 14 / 10 / 6 | 14 / 10 / **0** (dropped) |
| p50 anchors (min → score) | 3→100, 5→90, 10→75, 20→55, 40→30, 90→10, 180→0 | 3→100, 5→90, **8→80, 12→65, 20→45, 45→15, 120→0** |
| p90 anchors | 5→100, 8→90, 15→75, 30→55, 60→30, 120→10, 240→0 | 5→100, 8→90, 15→75, **22→60, 40→40, 90→10, 180→0** |
| Expected p50 wait for the size | max(2, 5 × (lines/100k)^0.5) | max(2, **10.9 × (lines/100k)^0.23**) |
| Expected job-min per merged PR | max(10, 60 × (lines/100k)^0.5) | max(10, **155 × (lines/100k)^0.33**) |

**Why each change:**
- **Speed carries more of the score.** A slow but steady repo shouldn't reach B on reliability and efficiency alone. Under BASE, swift-syntax (24 min), tecnigrafo (15 min) and nextcloud/ios (30 min) scored 54–67 because their reliability was 90–100.
- **Red PR heads are dropped.** People push failing work in progress; that measures contributors, not CI. Flakes (green only on a rerun) and a red main stay.
- **The tail counts less.** 12 of 219 repos have a p90 over 10× their p50: terraform's is 398 min against a 5.9 min p50, and ash's 484 against 4.4. That looks like waits outside CI, such as approval gates or stuck runs, not slow CI. It is a guess from the numbers; I didn't open their runs. A tail weight of 15 let it sink fast repos.
- **The size curves are fitted to the data,** by log–log regression over all 219 repos with no labels involved, replacing guessed square roots. The fit is loose (r² 0.12 for both), so it's a fairness adjustment, not a prediction. It is gentler on small repos: a 100k-line repo is expected to take 10.9 min, not 5. It is stricter on huge ones: 5M lines is expected to take 26 min, not 35.
- **The wait anchors are steeper above 8 min,** so 20 min scores 45 for its wait instead of 55. This, with the weights, is what moves trusted-slow repos under 50.

## Results

Trusted set: 22 fast and 18 slow. All 219 repos count toward the grades.

| | BASE | CALIBRATED |
| --- | --- | --- |
| Trusted fast at 75 or more | 77% (17/22) | **91% (20/22)** |
| Trusted slow under 50 | 61% (11/18) | **89% (16/18)** |
| Trusted fast under 60 / trusted slow at 75 or more | 0 / 0 | 0 / 0 |
| Median: fast / slow | 91 / 47 | 93 / 40 |
| Any repo with p50 ≤ 5 min scoring under 60 | 0 | 0 |
| Any repo with p50 ≥ 20 min scoring 75 or more | 0 | 0 |
| All repos, p10 / p50 / p90 | 38 / 63 / 88 | 31 / 63 / 91 |
| Bands: ≥75 / 50–74 / <50 | 52 / 109 / 58 | 67 / 82 / 70 |
| Grades | S+ 4, A+ 6, A 6, B+ 16, B 20, C+ 27, C 48, D+ 12, D 22, F 58 | S+ 8, A+ 5, A 12, B+ 16, B 26, C+ 15, C 41, D+ 10, D 16, F 70 |

The spread widens out of C: a third of the repos sit at B or above and a third at F. The F share is high because `repos.csv` was gathered partly by looking for slow CI, so the sample leans slow. Expect fewer Fs on the site.

**Remaining misses (4):**
- tecnigrafo, labelled slow, scores 69. Its 15 min p50 is moderate, and its reliability and efficiency are near perfect.
- curl, labelled fast, scores 72. Its main is red 38% of the time.
- detekt, labelled fast, scores 71. It waits 11.9 min, borderline.
- swift-syntax, labelled slow, scores 54. It waits 24 min with perfect reliability.

**Named repos:**

| Repo | p50 (min) | BASE | CALIBRATED | Parts now (speed / rel / eff) |
| --- | --- | --- | --- | --- |
| pingdotgg/t3code | 3.3 | 97 | 98 | 99 / 100 / 91 |
| oxc-project/oxc | 5.2 | 89 | 89 | 93 / 99 / 69 |
| honojs/hono | 1.8 | 74 | 79 | 100 / 21 / 76 |
| vitejs/vite | 4.8 | 62 | 78 | 95 / 20 / 85 |
| astral-sh/ruff | 19.1 | 72 | 66 | 52 / 91 / 84 |
| facebook/react | 8.2 | 59 | 64 | 84 / 46 / 22 |
| biomejs/biome | 21.1 | 66 | 63 | 49 / 100 / 66 |
| vercel/next.js | 27.4 | 48 | 42 | 39 / 75 / 18 |
| microsoft/aspire | 34.5 | 37 | 34 | 25 / 31 / 67 |

The BASE column is `calibrate.py` re-scoring with today's `score.ts` config. Some stored reports carry an older score: ruff's card showed 61, aspire's 21 then 37, and React's 46.

- **React moves from 🐢 to 😐.** It now scores 64. What keeps it at C is efficiency 22 (job minutes and runs per merged PR are high) and an 11% flake rate. Its wait is fine.
- **Ruff and biome, at about 20 min, read C, not fast.** That fits the sense check that a score of 63 can't be fast.

## Overfitting

- **What was tuned:** about 7 choices against 40 trusted labels. Those were two free part weights, the tail weight, the red-heads weight, one of three p50 anchor sets, one of two p90 sets, and one of two size curves. The size curve's coefficients came from unlabelled data.
- **The grid search** (`calibration/grid.py`, 1,836 configs) ranked on half A only, split by a hash of the repo name: 11 fast and 12 slow. Its top configs all agreed on the fitted size curve, a tail weight of 5, and reliability at 15–20. On half B (11 fast, 6 slow) they scored as well as on A or better.
- **The final pick isn't a clean hold-out.** I chose D6 from a handful of candidates after seeing full-set results. D6 gets half A 82% / 83%, half B 100% / 100%. Half B is small (6 slow), so treat it as consistent, not proven.
- **The objective is flat.** Many configs tie on the labels, so the pick rests on the reasons above (speed first, drop red heads, measured size curve), not on the last few percent.

## What I tried and dropped

- **Speed weight 50 with reliability 15 and efficiency 35** (grid top). It matched on the labels but makes efficiency, the least visible part, outweigh reliability.
- **Speed 65–70.** No gain on the labels. Hono and vite drop again on their red-main rates, and react climbs.
- **Keeping the guessed size curve, with steep anchors** (D5). It gave the best slow score (89%), but fast fell to 86% and vite dropped to 68. It is harsh on small and mid repos.
- **A tail weight of 10** (D4). It cost 5 points on fast with no gain on slow.

## Porting to `score.ts` (done 19 Nov)

In `scoreOf` and its constants:
- `WAIT_P50 = [[3, 100], [5, 90], [8, 80], [12, 65], [20, 45], [45, 15], [120, 0]]`
- `WAIT_P90 = [[5, 100], [8, 90], [15, 75], [22, 60], [40, 40], [90, 10], [180, 0]]`
- `expectedWait = (lines) => Math.max(2, 10.9 * (Math.max(lines, 1) / 100_000) ** 0.23)`
- `expectedMinutesPerMergedPr = (lines) => Math.max(10, 155 * (Math.max(lines, 1) / 100_000) ** 0.33)`
- Speed: `w: 60`, with tail `w: 5`. Reliability: `w: 20`, with `redHeads` deleted. Efficiency stays at `w: 20`.
- Update the comments: "2 minutes is excellent; 40 is zero" no longer describes the anchors, and the forSize comment should say the curve is fitted.

Then:
- **Recompute every stored report's `score`, `parts` and `detail`** from its stored inputs. It needs no API calls, since `calibrate.py` already scores from them. That also clears the 9 reports whose stored score came from an older `scoreOf`: civitai, cube, inbox-zero, eliza, foldkit, kody, obsidian-copilot, opentelemetry-go and next.js.
- **Re-render the cards.** The percentile line and the medals read `score` from the reports.
- **Check the fixes in `fixesOf`.** Any fix that leaned on red PR heads or on `expectedWait` may change.

## Data issues found along the way (not fixed)

- **Vite's main is red 57% of the time: checked, and not a bug.** The 30 main pushes ran four workflows: `CI` (17 failed, 13 passed), `Preview release` and `Publish Package` (30 successes each), and `Zizmor`. All 17 red heads are `CI`, vite's own gating workflow, and its failures on main are real conclusions from GitHub. Commit titles in the window include "fix two flaky hmr playground tests" and "fix flaky assets build watch tests". Whether the failing job is required can't be told without per-job data, which isn't cached. `score.ts` is unchanged.
- **Hono shows a 26% green-on-rerun rate.** That's high, and it's real only if those reruns are of the same commit.
