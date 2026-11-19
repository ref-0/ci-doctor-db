# Brief: find more public repos to calibrate a CI score on

## Context
`~/ref0-work/ci-score/score.ts` scores a public GitHub repo's CI from its public GitHub Actions data:
- PR wait percentiles;
- flakes and red rates;
- CI minutes per merged PR;
- shard balance;
- a size profile.

The goal is that well-run repos score well. We calibrate on a list of repos: `~/ref0-work/ci-score/inbox/repos.csv` (112 repos, mostly AI-agent-heavy JS/TS). Six more have already been scored: honojs/hono, vitejs/vite, facebook/react, astral-sh/ruff, biomejs/biome and vercel/next.js. Find repos that broaden or improve that list. Leave out every repo already in it, or among those six.

## Every candidate must
- be public and active, with a push in the last 14 days;
- run CI on **GitHub Actions** for pull requests, with at least 5 `pull_request` workflow runs in the last 7 days. A repo whose PR checks run only on Prow, Buildkite, CircleCI or Jenkins doesn't count, because the scorer can't see them;
- not be archived, a mirror or a fork.

## The shared GitHub quota: important
The `gh` token on this machine is shared with a scoring batch that's running now. Protect it:
- **Make at most 150 REST ("core") calls in total.**
  - Check `gh api rate_limit --jq .resources.core.remaining` before each block of calls.
  - Stop calling the API if it's under 1500.
- **Make at most 10 search calls a minute.** Prefer web search, curated lists and pages you can read without the API.
- **GraphQL (`gh api graphql`) has its own quota.** Use it for stars, languages, pushed date and archived status, batching many repos in one query.
- **Check PR runs with one REST call per repo:** `repos/OWNER/REPO/actions/runs?event=pull_request&created=%3E%3D<date 7 days ago>&per_page=1`, and read `total_count`.
- **Don't run `score.ts`.**
- **Don't clone repos.**

## Output
Write only under `~/ref0-work/ci-score/research/<your slice folder>/`.
- **`candidates.csv`, 30 to 45 rows.** Columns:
  - `repo` (owner/name);
  - `url`;
  - `stars`;
  - `primary_languages`;
  - `monorepo_tool` (turbo, nx, bazel, cargo, go modules, pnpm-workspaces, single-package…, or `?`);
  - `pr_runs_7d` (the `total_count` above);
  - `loc_hint` (GitHub language bytes ÷ 30, rounded);
  - `expected` (fast, slow or unknown, as you'd expect the CI to score);
  - `why` (one line of evidence: a blog post, a docs page, a known practice such as a remote cache, sharding or a merge queue, or AGENTS.md);
  - `source` (a URL).
- **`NOTES.md`, at most 30 lines:** how you searched, the sources you used, the REST calls you made, and anything you couldn't reach and why.

Report only when you're done. Reply in at most 8 lines: the row count, your slice's mix, and the 5 most interesting picks.
