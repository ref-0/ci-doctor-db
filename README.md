# ci-doctor-db

What [ci-doctor](https://github.com/ref-0/ci-doctor) learns from measuring real repos' CI: how the score is calibrated, what the measurements show, and the loop that keeps measuring, comparing and feeding what it learns back into ci-doctor's scorer, guide and skills.

Every repo here is public, and every number comes from GitHub's public API: each repo's PR runs, jobs and a few job logs over its last 7 days.

## What's here

| Path | What it holds |
| --- | --- |
| [`FINDINGS.md`](FINDINGS.md) | What scoring 219 repos showed, dated |
| [`calibration.md`](calibration.md), [`calibrate.py`](calibrate.py), [`calibration/`](calibration/) | How the score's settings were chosen against labelled fast and slow repos, and how to reproduce it |
| [`inbox/`](inbox/), [`research/`](research/) | The repo lists and their labels |
| [`loop/`](loop/) | The learning loop: the database schema, the import, the weekly comparison and digest, the push to the score site's store (`loop/site.ts`), and the [proposals](loop/proposals.md) it feeds |
| [`LEARNING-LOOP.md`](LEARNING-LOOP.md) | The loop's plan, including field reports from people's agents |
| [`SITE.md`](SITE.md), [`card/`](card/), [`colour.ts`](colour.ts) | The score site's design and its social cards |
| [`NOTES.md`](NOTES.md), [`LAUNCH.md`](LAUNCH.md) | The first notes, and the launch plan |
| [`reports/`](reports/) | Every measured report, one JSON file per repo and date: the score and its parts, PR wait percentiles, jobs, tests, practices and stack. A `_rescored` file re-scores the report it sits beside |
| [`digest/`](digest/) | The loop's weekly comparison: the numbers as JSON, and a readable digest |
| [`submission/`](submission/), [`.github/workflows/submission.yml`](.github/workflows/submission.yml) | The check on a submitted report |

`loop.db` isn't in git: `node loop/import.ts` builds it from `reports/`. Nor is the raw API cache.

## Submit your repo

Score a public repo on your machine and send its report here as a pull request, with your own `gh` sign-in:

```sh
npx @ref0/ci-doctor --repo pip/garden --submit
```

It adds one new file, `reports/pip__garden/<date>.json`, under the repo's name as GitHub spells it: the report `--json` prints, with `submitted: { by, at }`, your login and the time. An unscored report isn't sent: there's nothing in it to compare.

A submission only adds a file. It never replaces a report here, measured or submitted, and the weekly measure skips a repo whose report for today is already here, so neither replaces the other. To send the same day's report again, use the pull request that's open.

Nothing here scores your repo again. The [submission check](.github/workflows/submission.yml) runs [`submission/check.ts`](submission/check.ts) from this repo's default branch, reads the pull request as data and runs nothing from it. It looks at:

- that the pull request adds exactly that one new file, and changes nothing else (anything else is left for a person);
- the scorer's own `smokeCheck` on the file: its fields and types, under 1 MB; only strings that are safe to show; a score; its path matching its repo and date, today's or yesterday's in UTC; made by the current scorer release; numbers in range and in order; links only into ci-doctor's guide; and a score, parts, detail and size that agree with the report's own measures, with enough of them to score;
- that `submitted.by` is who opened the pull request;
- one call about the repo: it exists, is public, is spelt exactly as GitHub spells it, and its main language is one the report lists.

It comments what it found, with two facts for whoever merges: whether the repo has reports here already, and whether the author owns it. It sets the `submission` status on the pull request's head commit: `error` when GitHub refused one of its calls, and nothing at all when the head moved while it ran, since the newer push's own run decides. A person merges every submission. Merge one for a repo measured here outside the weekly run's hours, Sunday 02:00 to 13:00: a report the run writes for the same repo and day while the submission lands is left in its checkout, which then can't fast-forward until that file is removed.

Once merged, the import keeps who submitted it (`reports.submitted_by`). A submitted report counts in its cohort and findings like a measured one, and a repo with only submitted reports is never measured here: the weekly queue leaves it out.

## Run it

Node 24 runs the TypeScript directly:

```sh
node loop/import.ts      # reports/ into loop.db
node loop/compare.ts     # the week's comparison, into digest/, or `no digest:` when nothing is newer than the last
node loop/digest.ts      # the readable digest, or the same `no digest:` line
node --test loop/test/   # the loop's tests
CI_DOCTOR_SCORER=<ci-doctor checkout>/scorer/src node --test submission/test/   # the submission check's
node loop/measure.ts --dry-run --max 10   # this week's queue, with each repo's reason
node loop/measure.ts     # the weekly run: find, measure, read practices again, store, publish (--push from main)
node loop/reread.ts --dry-run             # the latest reports whose practices the scorer's current detection hasn't read
node loop/reread.ts      # read them again and write each back in place (--all for every one, --push from main)
node loop/prune.ts --dry-run              # what cache retention would delete
```

The weekly run scores with ci-doctor's `main`, from its own checkout of it, with the `ref0-ci-doctor` App's token. It starts on Sunday at 02:00 and measures for 11 hours from its start (`--hours`), one run at a time, and pushes every report `origin/main` lacks, or holds at other content, as one data commit made on `origin/main`. Every tracked repo is due once its last report is 6 days old, adopters every run; one with no pull-request run since its last report is skipped and keeps that report, as a row in `loop.db`'s `skips`. After the checks, while its hours last, it reads again the practices of each latest report that an older version of the scorer's practice detection read, and logs each verdict that changed; `loop.db`'s `readings` says which detection read each one. Its log goes to `logs/measure-<date>.log`. The learn job runs at 14:00: `import.ts`, `compare.ts` and `digest.ts`, and a model writes the narrative only when `digest/<date>.md` was written. When `loop/schema.sql` adds a column, rebuild `loop.db` with `rm loop.db && node loop/import.ts`; a new table or view needs nothing, as `loop.db` gains it when next opened. A rebuilt `loop.db` has no `skips` or `readings`, which the import can't rebuild, so its next run reads every latest report's practices again.

Scoring a repo uses the published scorer, `npx @ref0/ci-doctor`.

## License

[MIT](LICENSE).
