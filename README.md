# ci-doctor-db

What [ci-doctor](https://github.com/ref-0/ci-doctor) learns from measuring real repos' CI: how the score is calibrated, what the measurements show, and the loop that keeps measuring, comparing and feeding what it learns back into ci-doctor's scorer, guide and skills.

Every repo here is public, and every number comes from GitHub's public API: each repo's PR runs, jobs and a few job logs over its last 7 days.

## What's here

| Path | What it holds |
| --- | --- |
| [`FINDINGS.md`](FINDINGS.md) | What scoring 219 repos showed, dated |
| [`calibration.md`](calibration.md), [`calibrate.py`](calibrate.py), [`calibration/`](calibration/) | How the score's settings were chosen against labelled fast and slow repos, and how to reproduce it |
| [`inbox/`](inbox/), [`research/`](research/) | The repo lists and their labels |
| [`loop/`](loop/) | The learning loop: the database schema, the import, the daily comparison and digest, and the [proposals](loop/proposals.md) it feeds |
| [`LEARNING-LOOP.md`](LEARNING-LOOP.md) | The loop's plan, including field reports from people's agents |
| [`SITE.md`](SITE.md), [`card/`](card/), [`colour.ts`](colour.ts) | The score site's design and its social cards |
| [`NOTES.md`](NOTES.md), [`LAUNCH.md`](LAUNCH.md) | The first notes, and the launch plan |
| [`reports/`](reports/) | Every measured report, one JSON file per repo and date: the score and its parts, PR wait percentiles, jobs, tests, practices and stack. A `_rescored` file re-scores the report it sits beside |
| [`digest/`](digest/) | The loop's daily comparison: the numbers as JSON, and a readable digest |

`loop.db` isn't in git: `node loop/import.ts` builds it from `reports/`. Nor is the raw API cache.

## Run it

Node 24 runs the TypeScript directly:

```sh
node loop/import.ts      # reports/ into loop.db
node loop/compare.ts     # the day's comparison, into digest/
node loop/digest.ts      # the readable digest
node --test loop/test/   # the loop's tests
node loop/measure.ts --dry-run --max 10   # tonight's queue, with each repo's reason
node loop/measure.ts     # the nightly job: find, measure, store, publish (--push from main)
node loop/prune.ts --dry-run              # what cache retention would delete
```

The nightly job scores with ci-doctor's `next`, from its own checkout at `~/ref0-work/ci-doctor-next`, with the `ref0-ci-doctor` App's token. Its log goes to `logs/measure-<date>.log`.

Scoring a repo uses the published scorer, `npx @ref0/ci-doctor`.

## License

[MIT](LICENSE).
