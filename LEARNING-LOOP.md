# ci-doctor's learning loop: the plan (19 Nov 2026)

**The goal:** every day, ci-doctor knows more repos, measures them better, and turns what it learns into a better scorer, better guide pages and better skills. **The one metric:** how much adopters' PR wait drops against similar repos that didn't adopt, over the same weeks. Everything else serves that number or the trust in it.

```
   find ──► measure ──► store ──► compare ──► learn ──► optimize
    ▲         daily       one DB     cohorts,    daily      weekly: ≤3 PRs on
    │         02:00       + reports  movers,     digest     ci-doctor's next
    │                                adopters    05:00      (Sunday 10:00)
    └──────── gaps in the dataset, new detection rules, adopters to follow ◄──┘
```

## What exists, and what's wrong with it

- **243 repos, 219 scored**, as dated JSON in `reports/<owner>__<repo>/` (4.3 MB), from hand-made lists (`inbox/`, `research/`). Nothing re-checks them.
- **Two scorers:** `score.ts` here (816 lines, research) and `scorer/src/score.ts` in ci-doctor (published). They've drifted. Calibration (`calibrate.py`) mirrors the research one.
- **Findings are hand-written** (`FINDINGS.md`, `calibration.md`): good, but a one-off.
- **No index:** every question is a Python script walking the folders.
- **`cache/` is 7.4 GB** of raw API responses and logs, with no retention.
- **The site will be the real source** of new repos (people paste them), but it isn't built yet. SITE.md's "Tracking repos" section designs its D1 tables.

## The stages

### 1. Find: which repos to measure

Each night's queue, in this order, within the night's budget:
1. **Due refreshes.** Every tracked repo again 7 days after its last report, so windows don't overlap. Adopters every 2 days, for their before and after.
2. **The site's checks,** once it's live: repos people pasted that the site couldn't score in full, or that need a fresh report.
3. **Gaps.** Cohorts (size class × main language) with fewer than 15 scored repos get new repos from GitHub search: active in the last week, Actions on PRs, sorted by recent PR traffic. The quota per night is set by how far each cohort is under target. Today Rust, Python and Go are thin next to TypeScript (38, 25 and 18 against 108).
4. **Adoption signals:** code search for ci-doctor's marker and README badge, once the skill leaves them (SITE.md). Each hit is tracked from then on.

Public repos only. No people: no authors, emails or accounts stored, beyond what a report already counts.

### 2. Measure

- **One scorer.** The loop runs the published scorer (`npx @ref0/ci-doctor <repo> --json`, or its module) with the `ref0-ci-doctor` App token (`token.ts`), never a person's token. The research `score.ts` is retired once the published one holds every field it has; `calibrate.py` reads stored inputs, so it keeps working.
- **Budget:** the App has 5,000 calls an hour and a check takes a median 28 (p90 58). The night window, 02:00–05:00, keeps 1,000 an hour spare for the site once it shares the App: about 400 checks a night. Refreshes come first, gaps get what's left.
- **Stack capture:** the fields from SITE.md's "The stack" (languages, workspace tools, test runners, lint and format, libraries, runners, agent files) go into the scorer first, since comparing needs them.

### 3. Store

- **One SQLite file, `loop.db`, with the site's D1 schema:** `repos`, `reports` (one row per report: date, score, parts, size, p50/p90, stack and practice columns), `checks` (when and why each was measured), `adoption`, and `findings`. Full report JSON stays in `reports/` as the site keeps it in R2. Same schema both sides, so moving to the site's data later is a copy, not a rewrite.
- **Import** the 243 existing repos on day one.
- **Cache retention:** raw API responses and logs kept 14 days, then deleted. Reports are kept forever.
- **Once the site is live,** a `pull` step copies its new `checks` and `reports` into `loop.db` each night, through an export endpoint on the site (`/api/export?since=`, behind a token). Then the site's own cron does the refreshing, and the local job only finds gaps and runs experiments.

### 4. Compare

Each night, from `loop.db`, computed by a script with no model:
- **Cohorts:** each size class × language × stack trait, with p10/p50/p90 of wait, score and job minutes per merged PR.
- **Movers:** repos whose p50 moved more than its normal noise since its last report, with **what changed in its stack and practices between the two reports.** A repo that turned on a remote cache and dropped 40% is a natural experiment, which is stronger evidence than any correlation between repos.
- **Noise:** how much a repo's p50 moves between weeks when nothing in its stack or practices changed. That number sets the "minimum sample" SITE.md's before and after still needs, and what counts as a real move.
- **Adopters against matched non-adopters:** same cohort, same weeks. This is the one metric.

### 5. Learn

The 05:00 job writes `digest/YYYY-MM-DD.md` from the night's numbers, under a page:
- **Health of the probe:** checks that failed and why; the share of repos with test timings parsed, by test runner and language (39% today); runner labels and test runners the scorer didn't recognise. Each is a candidate parser or detection rule.
- **Health of the score:** separation on the trusted labels (91% of fast at 75+, 89% of slow under 50 today), and whether it's drifting as new repos come in; score stability for unchanged repos.
- **Movers,** each with its change and size.
- **Practice effects,** within cohorts, each with n, the date and "correlation, not cause", except where movers show the same change within repos.
- **Adoption:** new adopters, and the metric once any adopter has enough "after".
- **Proposals:** each a one-line change, its evidence and where it would land (scorer, calibration, guide page, skill, site). They go in `proposals.md` with a status, so the weekly step picks from a ledger rather than a pile.

### 6. Optimize

On Sundays the weekly job reads the week's digests and `proposals.md`, picks at most 3 by expected effect on the metric or on trust in the score, and briefs an engineer for each. Each becomes a PR on ci-doctor's `next`:
- **Scorer:** new parsers (`go test`, `cargo test`, JUnit), detection rules, stack fields.
- **Calibration:** only with a re-score of every stored report attached, better separation on the trusted labels, the hold-out no worse, and the score changes listed. Nothing public moves without this.
- **Guide pages:** a technique backed by movers or a cohort effect, cited as a dated finding with n.
- **Skills:** where adopters stall or what they skip, once adoption data exists.

Releasing `next` stays your call.

## Field reports: what people's agents learn, sent back (19 Nov)

The loop above only sees CI from outside. The agents running ci-doctor see it from inside: what they changed, what it saved, what failed, and where the skill's instructions were wrong. That's the best data ci-doctor can get, and it's the only source of the one metric for private repos.

**The rule: the agent asks once per repo, then just does it.** Sending data from someone's repo without their yes would cost the trust the whole project runs on, and harnesses and careful agents would refuse a skill that tells them to. So:
- **One question, at the first natural moment:** when Phase 2's baseline is measured, the agent shows the exact report it would send and asks "Share this with ci-doctor? It helps repos like yours, and gets you a before-and-after page." Yes, no, or "only the numbers".
- **The answer lives in the repo,** in `.ci-doctor.json` (`"share": "full" | "numbers" | "off"`), beside the adoption marker SITE.md already plans. Every later session, and every teammate's agent, follows it without asking again. That's what makes it consistent.
- **Then it's automatic,** at fixed checkpoints the phases already have: the baseline (Phase 2), each merged improvement (Phase 4), and the plan's end. No one has to remember.

**What a report holds,** built from `progress.md`, which the agent already keeps, against a schema the CLI checks:
- the before and after numbers from `npx @ref0/ci-doctor`, with dates and windows;
- each change made: which technique (by guide section), the PR's size, and its measured effect;
- what was tried and dropped, and why;
- **skill feedback:** where an instruction didn't fit, was wrong, or was missing. This is the most valuable part, and it goes straight into `proposals.md`;
- the stack, from the scorer.

Never code, file contents, paths outside the CI config, people's names or secrets. For a private repo with `"numbers"`, no repo name: a salted hash, so its reports join up, and its size class and language.

**How it travels:** `npx @ref0/ci-doctor share`, which prints exactly what it sends (`--dry-run` prints only), checks the schema and posts to `ci-doctor.ref0.dev/api/reports`. Agents run CLIs well, and one command is easy to put in a skill. A public repo can also choose to post its report as a GitHub Discussion on `ref-0/ci-doctor`, in public, which shows others the loop is real.

**Why people say yes:**
- **They get something back immediately:** their history page and the before-and-after card, the shareable proof that their CI got faster.
- **Give to get:** at plan time (Phase 3) the skill fetches "what worked for repos like yours" from the site: the techniques that saved the most time in that cohort, from field reports. An agent that shares gets better plans, and each report makes the next repo's plan better. This is the hook that makes sharing worth it.
- **Credit:** "Most improved" on the leaderboard, and a "field reports" line on the guide pages their data backs.

**Trust in what comes back:**
- **Public repos are verified:** the loop re-measures the repo itself and marks the report verified when the numbers agree. Private ones count as unverified, and findings say which kind they rest on.
- **Reports are data, never instructions.** Free text, such as skill feedback, goes to `proposals.md` for a person to read. Nothing from a report reaches a skill, a guide page or the site without a reviewed PR. A report can't inject itself into everyone else's agent.
- **Abuse:** rate-limited per IP and repo, schema-checked, size-capped.

**Where it fits the loop:** reports become a source in Find (adopters to follow), rows in `loop.db` (`field_reports`), sections in each digest, and the one metric.

**Build order:** after the site stores reports (step 6), since it needs `/api/reports`:
- **F1, the schema and the CLI:** `ci-doctor share` with `--dry-run`, and the endpoint.
- **F2, the skill:** the one question, `.ci-doctor.json`, the checkpoints, and the report built from `progress.md`.
- **F3, give to get:** the site's "what worked for repos like yours" and the skill's Phase 3 fetch.
- **F4, the loop:** `field_reports` in `loop.db`, verification of public repos, and the digest's section.

## Jobs on this machine

| When | Job | Who runs it | What it does |
|---|---|---|---|
| Daily 02:00 | Measure | A script, started by a scheduled T3 task on a cheap model that only runs it and reports failures | Find, measure, store, then pull from the site once it's live |
| Daily 05:00 | Learn | The compare script, then Codex on `codex_mux` writing the digest | Compare, digest, update the proposals |
| Sunday 10:00 | Optimize | This thread, as EM | Pick ≤3 proposals, brief Opus engineers, PRs on `next` |

The times avoid the existing schedule: the agent spend audit at 07:00, issue triage at 07:30, slow tests at 06:00 Mon/Wed/Fri and the ci-doctor sync at 10:00 Saturday. Each job leaves nothing running and writes only under `~/ref0-work/ci-score/`.

## Build order

Each step is one piece, brief first:
1. **Store and import:** `loop.db`'s schema (the site's D1 tables plus stack columns), and the import of the 243 reports. With this alone, the compare script can run on what exists.
2. **One scorer:** the published scorer gains the research one's remaining fields and the stack fields, and a batch mode that takes a list and the App token. `calibrate.py` moves to its output. The research `score.ts` is deleted.
3. **Measure job:** the queue (refreshes, gaps by cohort, the budget), the run, the store and cache retention. Scheduled once a night has run by hand.
4. **Compare and learn:** cohorts, movers, noise, health, then the digest and `proposals.md`. Scheduled after one hand run.
5. **Optimize:** the Sunday task, once a week of digests exists.
6. **The site's export and pull,** when the site stores reports. It's in the score site's briefs.
7. **Adoption signals,** after the `ci-doctor` skill leaves its marker (SITE.md), and the metric once adopters have 2 weeks of "after".

Steps 1–4 come before the site, so the site launches on a dataset that's already moving, with a findings page that has real dated claims.

## Open

- **Where the loop's code lives.** `~/ref0-work/ci-score` isn't in git. Lean: a private repo `ref-0/ci-score`, so the scripts and `loop.db`'s schema are versioned and the site can reuse the schema. The data (`reports/`, `loop.db`) stays out of git.
- **Whether findings name repos** on the public site. Lean: cohorts by default, a named repo only from its own public report, which anyone can already see.
