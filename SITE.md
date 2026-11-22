# CI score site: the design (18 Nov 2026)

Agreed on 18 Nov:
- **Build it with ref0's component library** (`@ref0/ui`), following the `brand` and `ui-design` skills.
- **The header** has the "ref0 ci-doctor" logo lockup on the left and the GitHub logo, linking to ci-doctor, on the right.
- **The middle of the landing page** is one input: paste your GitHub repo.
- **The agent prompt is always a clear code block**, its text neatly wrapped, with a Copy button.
- **Every report has a Copy page split button** in the shadcn style.
- **"Where you stand" and "Replay a PR run"** are the centrepieces.
- **Every measured repo becomes data.** Reports compare a repo with similar repos, and the site states what the dataset shows.
- **The X card isn't decided.** The text mock-up wasn't exciting enough. See [The X card](#the-x-card-open).
- **Deploy it on Cloudflare,** very fast and cheap to run. See [Architecture](#architecture-on-cloudflare).
- **The home page shows recently checked repos:** what people have run.
- **React,** because `@ref0/ui` is React. Build it with ref0's UI skills. See [Building](#building).

Mock-ups use next.js's real report from 18 Nov. `N%` and "shape only" mark what isn't measured yet.

## 1. Landing

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ref0 ci-doctor                                         [GitHub] ★ 1.2k   │
│                                                                          │
│                       How fast is your CI?                               │
│                                                                          │
│        ┌─────────────────────────────────────────────┐ ┌──────────┐      │
│        │ github.com/ owner/repo                      │ │  Fix →   │      │
│        └─────────────────────────────────────────────┘ └──────────┘      │
│            try  honojs/hono · vitejs/vite · vercel/next.js               │
│                                                                          │
│        Private or local repo?  ┌───────────────────────────────┐         │
│                                │ $ npx @ref0/ci-doctor  [Copy] │         │
│                                └───────────────────────────────┘         │
│                                                                          │
│   Or skip the report. Paste this into your coding agent:                 │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │ prompt                                                [ Copy ]   │   │
│   │──────────────────────────────────────────────────────────────────│   │
│   │  Install the ci-doctor skills using one method. In Claude Code,  │   │
│   │  run `claude plugin marketplace add ref-0/ci-doctor`, then …     │   │
│   │  Then use the ci-doctor skill to start its plan for this repo.   │   │
│   └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│   Recently checked                                       live ●          │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │ vercel/next.js       31  ████░░░░░░   26.8 min        just now   │   │
│   │ honojs/hono          76  ████████░░    1.8 min        2 min ago  │   │
│   │ vitejs/vite          56  ██████░░░░    4.9 min        5 min ago  │   │
│   │ astral-sh/ruff       61  ██████░░░░   19.1 min        9 min ago  │   │
│   └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│   N repos measured · median PR wait N min · p90 N min    Leaderboard →   │
└──────────────────────────────────────────────────────────────────────────┘
```

- **The prompt is the ci-doctor README's AI Quickstart prompt, word for word** (changed 19 Nov from the clone-and-read-PROMPT.md prompt, now that ci-doctor is a plugin); the box shows it whole, wrapped. On a report, it ends with "Start from this CI report:" and the `<ci-report>` block.
- **Under the paste box, for private or local repos:** "Private or local repo?" and `npx @ref0/ci-doctor` in a mono box with a Copy button (decided 19 Nov). It runs the same report on the person's machine with their own `gh` sign-in, so nothing about the repo reaches the site. See [Private repos](#private-repos).
- **Recently checked** shows the newest reports, one row per repo, each linking to its report.
  - New rows slide in at the top while the page is open.
  - It lists only repos whose report finished and that have CI runs.
  - Every repo is public, and it never shows who ran the check.
- **The dataset line** states what the measured repos show, and updates as repos are added.

## 2. While it runs (about 10–20 s)

Each step appears as it finishes, like a build log:

```
   vercel/next.js
   ✓  Read 996 workflow runs                         0.4 days of history
   ✓  Timed every PR push
   ◐  Sampling jobs from build-and-test   ▓▓▓▓▓▓▓░░░░░
   ○  Reading test logs
   ○  Scoring
```

## 3. Report: the top

- **Animation:** the score counts up from 0 over about 900 ms, ease-out, then the three bars fill one after another, about 120 ms apart.
- **The personalized prompt** sits right under the score, because it's the call to action.
- **Copy page** is a split button on the title row:
  - Copy as Markdown;
  - Copy as JSON, for agents;
  - View as Markdown, at `/<owner>/<repo>.md`;
  - Open in Claude;
  - Open in ChatGPT.
- **Share** is a split button beside Copy page (decided 19 Nov). The report link alone already unfurls as the card, so this only makes posting one click:
  - **Post on X:** X's compose intent, filled in with "My CI scores 97/100 🔥 PR checks in 3.3 min, faster than 98% of large repos. How's yours?" and the report link. The wording follows the card: "slower than" when the repo is behind, and the same emoji by band.
  - **Share on LinkedIn:** LinkedIn's share URL with the report link.
  - **Copy link.**
  - **Download image:** the card's PNG, for Discord or a slide.
  - **Copy README badge:** see [README badge](#readme-badge).

```
 pingdotgg/t3code 🔥                          [ Share ▾ ] [ Copy page ▾ ]
                                              ┌──────────────────────────┐
                                              │ 𝕏  Post on X             │
                                              │ in Share on LinkedIn     │
                                              │ 🔗 Copy link             │
                                              │ ↓  Download image        │
                                              │ ▣  Copy README badge     │
                                              └──────────────────────────┘
```

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ref0 ci-doctor                                         [GitHub] ★ 1.2k   │
│──────────────────────────────────────────────────────────────────────────│
│ vercel/next.js 🐢                    [ Share ▾ ] ┌─────────────┬───┐     │
│ 18 Nov 2026 · last 7 days                        │ ⧉ Copy page │ ▾ │     │
│ 2.8M lines · 274 packages · 73 crates            └─────────────┴───┘     │
│ 184 PRs merged a week                       ┌──────────────────────────┐ │
│                                             │ ⧉  Copy as Markdown      │ │
│   ╭────────╮                                │ {} Copy as JSON          │ │
│   │   31   │  Speed        ███████░░░░░░░   │ ↗  View as Markdown      │ │
│   ╰────────╯  Reliability  ████████████░░   │ ✦  Open in Claude        │ │
│    of 100     Efficiency   ████░░░░░░░░░░   │ ✦  Open in ChatGPT       │ │
│                                             └──────────────────────────┘ │
│   A PR waits 26.8 min for CI. Slower than N% of large repos.             │
│                                                                          │
│   Fix it with your agent                                                 │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │ prompt · includes this report                        [ Copy ]    │   │
│   │──────────────────────────────────────────────────────────────────│   │
│   │  Install the ci-doctor skills using one method. In Claude Code,  │   │
│   │  run `claude plugin marketplace add ref-0/ci-doctor`, then …     │   │
│   │  Then use the ci-doctor skill to start its plan for this repo.   │   │
│   │  Start from this CI report:                                      │   │
│   │                                                                  │   │
│   │  <ci-report repo="vercel/next.js" date="2026-11-18">             │   │
│   │  Score 31/100: speed 27, reliability 47, efficiency 17           │   │
│   │  PR wait p50 / p75 / p90: 26.8 / 31.8 / 37.5 min                 │   │
│   │  Queue p90 177 s · red heads 31% · green only on rerun 11%       │   │
│   │  CI per merged PR: 3,854 job-min                                 │   │
│   │  Shards "test prod": 10, slowest 1.46× median, 28% idle          │   │
│   │  Fix first: 1. setup is 71% of job time (06)                     │   │
│   │             2. balance shards by measured time (07)              │   │
│   │             3. 39 test files over 10 s (10)                      │   │
│   │  </ci-report>                                                    │   │
│   └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

## 4. Where you stand

Each dot is a measured repo of the same size class, and your marker slides in last. This strip is where "faster than N%" comes from.

```
   PR wait against large repos                                    minutes
   0       5       10      15      20      25      30      35      40
   ├───────┼───────┼───────┼───────┼───────┼───────┼───────┼───────┤
     · ·:·:·::·:·::·:·:·:··:· · :· ·  · ·    ●━━━━━━━━┿━━━━━━━━━▶
                                            p50 26.8  p75 31.8  p90 37.5
```

## 5. Similar repos

Similar means the same size class, the nearest in lines of code and PR traffic, an overlapping main language, and then the most stack in common (section 7: workspace tools, test runner, package manager, key libraries). **The table shows the 10 nearest** (asked 19 Nov), fewer only when the dataset has fewer, each with its dominant language's icon, lines, PR wait p50, CI minutes per merged PR and score, sorted by score. Each row links to that repo's report, and the row's stack chips show what it shares with yours. A size-against-wait plot shows the expected-for-size curve, so a big repo can see it beats its peers even with a long wait.

The table below uses real numbers from 18 Nov.

```
   Repos like next.js · large · JS/TS + Rust
   ┌─────────────────────────────────────────────────────────────────┐
   │ PR wait                                                         │
   │ 30 min ┤                                         ● next.js 26.8 │
   │        │                     biome 21.1 ●             ╱╱        │
   │ 20     ┤               ruff 19.1 ●             ╱╱╱  expected    │
   │        │                            ╱╱╱╱╱╱╱       for size      │
   │ 10     ┤      react 8.2 ●  ╱╱╱╱╱╱                               │
   │        │ ╱╱╱╱╱╱╱╱                                               │
   │  0     ┼──────────────┬───────────────┬───────────────┬──────   │
   │              300k            1M              3M      lines      │
   └─────────────────────────────────────────────────────────────────┘
   repo        lines   PR wait p50   CI min / merged PR   score
   ruff        1.0M    19.1          83                   61
   biome       1.3M    21.1          350                  55
   react       384k    8.2           5,980                46
   next.js     2.8M    26.8          3,854                31
```

## 6. Replay a PR run

A timeline in the style of Vercel's build view. It plays the real run back at 60× speed, so you watch shards finish and then wait on the slowest one. Setup cost, imbalanced shards and the job everything waits on are all visible. The scorer already reads each job's and step's times, so the bars can be drawn to scale. The bar lengths below are shape only.

```
   One run of build-and-test · 20.6 min · 105 jobs         ▶ Replay  1×|60×
   0          5          10         15         20 min
   ├──────────┼──────────┼──────────┼──────────┤
   build      ░░░░██████▏
   test 1/10            ░░░░░░░██████▏·········   ░ setup   █ work
   test 2/10            ░░░░░░░███████▏········   · waiting on slowest
   test 3/10            ░░░░░░░█████▏··········
   test 5/10            ░░░░░░░████████████████▏  ← 16.9 min, sets the wait
   …
   ───────────────────────────────────────────────────────────────────
   Slowest shard 1.46× the median · 28% of shard time idle · setup 71%
```

## 7. The repo, and its slowest tests

```
   ┌ The repo ───────────────────────┐  ┌ Slowest tests ───────────────────┐
   │ 2.8M lines                      │  │ batch_get_misses…case_2   1210 s │
   │ JS 47 · TS 35 · Rust 16         │  │ batch_get_misses…case_1   1200 s │
   │ tests ████████░░░░░░░░░░  29%   │  │ test_matches_sorting       685 s │
   │ ≥125 commits/wk · ≥41 people    │  │ … 39 over 10 s                   │
   │ pace ▁▂▂▃▃▄▅▅▆▇  1.4× the year  │  │ under Miri, in turbo-persistence │
   │ 21.6 PR runs per merged PR      │  └──────────────────────────────────┘
   └─────────────────────────────────┘
```

Each profile number also shows how it compares with similar repos, for example "tests 29% · similar repos 18–44%".

### The stack (asked 19 Nov)

A section of its own beside The repo: what the repo is built with, captured on every report so similar repos, the leaderboard's filters and the findings page can use it.

```
   ┌ The stack ─────────────────────────────────────────────────────────┐
   │ Languages      JS 47% · TS 35% · Rust 16%     ███████▓▓▓▓▓░░░      │
   │ Workspace      pnpm · Turborepo · 274 packages · 73 crates         │
   │ Tests          Jest · Playwright · cargo nextest                   │
   │ Lint, format   ESLint · Prettier · Clippy                          │
   │ Libraries      React · Next.js · SWC · Turbopack · Tokio           │
   │ CI             GitHub Actions on GitHub-hosted larger runners      │
   │ Agent rules    AGENTS.md · .cursor/rules                           │
   └────────────────────────────────────────────────────────────────────┘
```

- **Each chip links** to the leaderboard filtered to it, and shows its share among similar repos on hover ("41% of large TS repos use Turborepo").
- **What the scorer captures:** most of it already (`profile.languages`, `profile.packages`, and `practices`' task runner, package manager, linters, test runner, runner provider, agent files). New: formatters, more test runners (Playwright, pytest, go test), libraries and frameworks read from the root manifests and the workspace's (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `Gemfile`), counted by how many packages use each, top 8 shown.
- **Stored as columns and a JSON field in D1,** so "similar" and the filters are SQL.

## 7b. Your five graphs (asked 19 Nov)

"Optimize all of your graphs": the report draws the five graphs that decide how far a change reaches and how long CI waits, each with its flagged issues first, and the fix linked to its guide section. An overloaded export path, for example, can make one edit invalidate most of the workspace's affected checks and caches.

```
   Your graphs                                        measured 18 Nov · ⓘ how
   ┌ 1 Packages ───────────────┐ ┌ 2 Export paths ──────────────────────────┐
   │   app ─┐                  │ │ ⚠ core "."  re-exports 340 modules,       │
   │   cli ─┼─► core ◄─ sdk    │ │   imported by 42 packages: an edit to any │
   │  web ──┘    ▲ ⟲ model     │ │   of them triggers 42 packages' checks    │
   │ ⚠ cycle core ⇄ model      │ │ ⚠ ui   no exports map                     │
   │ ⚠ core: 31 of 38 depend   │ │ ✓ sdk  6 entries, source first            │
   └───────────────────────────┘ └──────────────────────────────────────────┘
   ┌ 3 Layers in packages ─────┐ ┌ 4 Workspace tasks ───────────────────────┐
   │ core: 4 folders, 2 cycles │ │ ⚠ test: no declared inputs, cache misses  │
   │ from your agent's run ✦   │ │ ⚠ build: inputs cover 92% of the repo     │
   └───────────────────────────┘ └──────────────────────────────────────────┘
   ┌ 5 CI jobs ─────────────────────────────────────────────────────────────┐
   │ setup ─► build ─► test 1..10 ─► pack ─► result      chain sets 21.4 min │
   │ ⚠ test 5/10 blocks 38 job-min downstream · ⚠ build waits 2.1 min queued  │
   └────────────────────────────────────────────────────────────────────────┘
```

- **Each graph is drawn,** small and interactive: nodes sized by fan-in, the flagged node or edge in the score's colour, the rest monochrome (as everywhere else). Hovering a flag shows its numbers and the guide link; "Fix it" adds it to the agent prompt.
- **What the site can measure from outside,** with no clone and few API calls:
  - **1 Packages:** every manifest, which the scorer already reads (P-011): edges, cycles, depth, fan-in hubs.
  - **2 Export paths:** each package's `exports` map, plus its entry files, fetched from `raw.githubusercontent.com` (not counted against the API): `export *`, re-exported module counts, root barrels. **Overload** is re-exported modules × importing packages, the edit-to-invalidation fan-out (P-014).
  - **4 Workspace tasks:** `turbo.json`, `nx.json` and Vite+ task config by raw fetch: task dependencies, tasks with no inputs, inputs that cover most of the repo.
  - **5 CI jobs:** the job graph from the workflow files and the jobs API (P-010): the chain that sets the wait, blocked against queued time, the top blocker. The replay (section 6) animates the same graph.
- **What needs the repo itself:** 3 Layers in packages, the file import graph, and **what triggers what** (replaying commits through the graph) come from `scripts/graph/`, run by the person's agent. They appear on the report only through a field report (LEARNING-LOOP.md), marked ✦ "from your agent's run" with its date; until then the panel says how to get it.
- **Flags are dated claims with numbers,** never adjectives: "imported by 42 packages", not "too big". Each has its threshold from the dataset ("worse than 90% of large TypeScript repos") once the loop has enough repos.
- **For agents:** the graphs and flags are in `/<owner>/<repo>.json` and the `<ci-report>` block, one line per flag.

## 8. Fix first

```
   ┌─ 1 ──────────────────────────────────────────────── guide 06 → ┐
   │ Setup is 71% of job time. Cache dependencies and build once.   │
   ├─ 2 ──────────────────────────────────────────────── guide 07 → ┤
   │ Slowest shard takes 1.46× the median. Balance by measured time.│
   ├─ 3 ──────────────────────────────────────────────── guide 10 → ┤
   │ 39 test files take over 10 s.                                  │
   └────────────────────────────────────────────────────────────────┘
```

**Notes sit under the fixes, muted, and are never fixes** (decided 19 Nov): things worth knowing that the measurements don't show as a CI problem. The first is a missing `AGENTS.md`. Fixes are only what the run data points at.

## 9. Leaderboard

Tabs by size class. Each row links to its report. A trend column comes from the dated report history.

- **Each tab says what its size class is** (21 Nov): "Repos with 1M or more lines of code or 250 or more PR pushes a week." A repo takes the larger of the two classes. No description under the page title.
- **The nav marks the current page.**
- **A "for its size" note on each row** (agreed 21 Nov), such as "3× faster than usual for 1.4M lines": the wait against the size curve's expectation. The score's size weight stays modest: size explains 12% of wait across 219 repos.
- **Ranked by how the time has held** (agreed 21 Nov), once history exists: the median of the last 4 weekly scores from the nightly re-check, so one good or bad window doesn't move a repo. A repo with one measurement is marked "new" until it has more. Optionally a consistency signal, the spread of its weekly waits. Until then, ranking stays on the newest score.

```
   Tiny   Small   [Medium]   Large            sort: score ▾
   #  repo                 score  p50 wait  reliability  trend
   1  …                     …      …         …            ▲
```

## README badge

Decided 19 Nov: every report offers a badge for the repo's README, and it's the main growth loop. Each repo that adds one advertises the site to its visitors, and the badge is a public sign the repo adopted the site (signal 2 under [Tracking](#tracking-repos-adoption-and-improvement)).

```
 ┌──────────┬────────┐
 │ CI score │ 97 🔥  │   ← links to ci-doctor.ref0.dev/pingdotgg/t3code
 └──────────┴────────┘
```

- **Markdown to copy:** `[![CI score](https://ci-doctor.ref0.dev/badge/pingdotgg/t3code.svg)](https://ci-doctor.ref0.dev/pingdotgg/t3code)`.
- **The badge is an SVG the Worker draws from the latest report:** the score in `scoreColour` on the dark ground, the label in muted ink, sized like shields.io badges so it sits in a row of them.
- **It updates with the nightly re-score.** It's served with a short cache (about an hour) and an ETag, because GitHub's image proxy (camo) caches by response headers.
- **A repo with no report yet** gets a neutral "CI score · check" badge that links to the paste page, so adding the badge first still works.
- **What we can't see:** camo hides who views the README, so badge requests show only that a repo's badge is live, not its audience.

## Pages, and each one's card

Decided 19 Nov. Every page that can be shared gets its own card, drawn by `card/render.mjs` from the stored reports.

| Page | What it is | Its card (`node render.mjs …`) |
|---|---|---|
| `/` | The hero, the skills, Score your CI | `home` (redrawn 22 Nov): "Burning time and money on CI?" and "Skills that teach your coding agents to make CI fast, reliable and efficient, and keep it that way.", over three skill cards fanned a little, ci-doctor's in the middle in the site's blue ("Measures your CI, then plans and fixes it."), speed-up-tests and cache-ci either side. Six cards in a pile were too crowded |
| `/owner/repo` | The report | `repo owner/repo`: A2, the score card. Decided 19 Nov, for every card that names a repo (repo, history and compare): the dominant language's icon left of the repo name, from Pierre's set (`card/pierre/`, MIT), in the language's GitHub colour. A language the set doesn't have, or none, draws no icon. A chip after the name, the name in the footer, Simple Icons' logos (Rust's is black on dark, Go's and .NET's are wordmarks) and muted icons were tried |
| `/owner/repo/history` | Score and wait over time, the adoption date marked | `history` (drawn 19 Nov): the repo's name, left-aligned and close over the cards, then the home card's before and after (inner padding trimmed a little), centred between the header and the footer's rule, with its real scores and p50 waits, the pill saying "**N×** faster". The footer says "**11** days" since the split on the left and "**12.4** min saved per PR" (p50 before minus after) on the right. Locked 19 Nov; a split date, "+N points", the two windows' dates and run counts were tried. See [Before and after](#before-and-after) |
| `/compare/a/b…` | 2 or 3 repos side by side | `compare a b [c]`: each repo with a medal by score (🥇🥈🥉), its lines and p50 wait under the name ("1.4M lines · 5.2 min"), a bar of its score and the score in `scoreColour`; footer "oxc finishes PR checks **4.1× faster** than biome", fastest against slowest by wait (decided 19 Nov); under 1.1×, "**django** and **cli** finish PR checks in about the same time" |
| `/scores` | Scores: score your repo, How it works, Findings, the leaderboard | `scores` (drawn 22 Nov): "Score your CI" and "How fast and how reliable your CI is, out of 100, ranked against repos its size.", over the before and after (31, 24.1 min → 92, 3.2 min, the pill "/ci-doctor"). Replaces the paste box card, which read as a form. A repo's report, history and compare share it on the site until they're drawn on request |
| `/scores/findings` | Dated claims from the data | `findings` (drawn 22 Nov): "Findings" and its line, over one claim as a tile: the median p50 PR wait across the scored repos, a snapshot from `reports/` redrawn with the cards |
| `/scores/how-it-works` | How the score is measured | `how` (drawn 22 Nov): "How it works" and its line, over the three parts as one bar, each segment as wide as its weight (speed 60, reliability 20, efficiency 20) |
| `/owner/repo.md`, `.json` | The report for agents, behind Copy page | None |
| `/badge/owner/repo.svg` | The README badge | None |

## Grades

Decided 19 Nov: S+ for 97 and up, then a letter at 90, 75, 60 and 50, with a + on each band's top and no minus. F, under 50, has no sign. `grade()` in `score.ts` is the one definition; reports, cards and the site use it.

| Grade | Scores |
|---|---|
| S+ | 97–100 |
| A+, A | 94–96, 90–93 |
| B+, B | 85–89, 75–84 |
| C+, C | 70–74, 60–69 |
| D+, D | 57–59, 50–56 |
| F | under 50 |

On cards the grade is a tile tinted with the score's colour, one width for every grade so tiles line up: after each score on compare. The score card and home show no grade (dropped 19 Nov: the number and its colour already say it).

## Score colour

Agreed 18 Nov: the score's colour shifts gradually from red to green as the score rises, with its turns on the grade boundaries so colour and letter agree. A 63 never shows green.
- **Red under 50 (F), a quick turn through orange across D and C (50–74), green from 75 (B and A).** In OKLCH, hue 29° to 45, 58° at 62, 145° at 75, 152° at 100.
- **Lightness is set per ground** (0.68–0.74 on dark, 0.48–0.52 on light), and chroma is 92% of what sRGB can show at each step, so the middle stays vivid instead of olive.
- **Contrast, measured over every score:** at least 6.2:1 on gray-950 and 4.9:1 on gray-50.
- **One function draws it everywhere:** `scoreColour(score, ground)` in `colour.ts` returns hex, for the site and the Satori cards. `node colour.ts` prints the contrast check.
- **Colour is never the only cue:** the number always goes with it.
- **Everything else stays monochrome.** Only the score, and the "you" marker in Where you stand and the race, take the colour.
- Variants A (vivid sweep) and B (through a neutral) were set aside: A's yellow-green fell to 3.4:1 on light, and B's plain middle didn't read as red to green.

## The data, stated

As repos are measured, the dataset becomes content of its own:
- **On each report:** "Slower than N% of large repos", similar repos (section 5), and each profile number with its peer range.
- **On the landing page:** repos measured, the median and p90 PR wait, and this week's movers.
- **Later, a findings page:** for example, "repos with a remote cache wait N% less at the same size". Every claim on it is dated and from measured repos only.

## The X card (open)

**Picked 19 Nov: A2, the score card.** Card A without its dot plot. It shows:
- the wordmark lockup and the report URL;
- the repo name, with an emoji for its band: 🔥 from 75, 😐 from 50, 🐢 under 50 (Twemoji SVGs, since Satori has no emoji font). Each emoji's drawing is centred on the capitals' centre, measured in pixels; the turtle fills only the bottom of its box, so it is drawn at 44 px instead of 36 and raised more;
- the score at 220 px, in `scoreColour`, 26 px below the repo name, with "/100" spaced optically: a score ending in 7 pulls it in, since the 7 is empty at its bottom right (measured from the font);
- the three bars on the right, flush right and starting about where the bottom line's right half starts: 31 px labels in a column fitted to "Reliability" (a 22 px gap to the bar), 250 × 16 px bars in muted ink (#b4b3ac), and scores in bold sans. Bars coloured by their own score were tried and were too much;
- a rule, then a muted timer icon (Lucide) and "**N** min · **N** lines" on the left, and where it stands on the right, by score among scored repos of its size class: "Top **N%** of <size> repos" in the top quarter, "Bottom **N%** of <size> repos" in the bottom quarter, and "About average for <size> repos" in the middle half, where "Top 49%" read like praise (decided 19 Nov; "faster than N%", "Beats N%" and a "#N of M" rank were tried). Muted text, with only the numbers bold in full ink. Lines are written "1.6M", "1M", "48k", or the exact count under a thousand, and every count agrees with its noun ("1 line", "1 repo").

It's drawn by `repo` in `card/render.mjs` (`cd card && node render.mjs repo owner/repo`). It shows no grade; "/100" sits on the number's baseline (see [Grades](#grades)).

Agreed 18 Nov: someone posts their repo's report link, and X, LinkedIn, Slack and Discord show a generated image of their score.

**How:**
- **Rendering:** Vercel's Satori turns JSX into SVG, and resvg (WASM) turns the SVG into a PNG. Both run in the Worker. This is the stack `@vercel/og` uses; on Workers, use `satori` with `@resvg/resvg-wasm`, or `workers-og`.
  - Satori supports a flexbox subset of CSS, so the card is drawn with brand tokens, not `@ref0/ui` components.
  - Fonts load as TTF, OTF or WOFF, not WOFF2: Host Grotesk and IBM Plex Mono.
  - The wordmark goes in as an inline SVG.
- **One image per report, rendered when the report is written,** and stored in R2 at `og/<owner>/<repo>/<date>.png`.
- **The report page's `og:image` and `twitter:image` URLs include the report's date.** Each URL is immutable, so it's served with `Cache-Control: public, max-age=31536000, immutable` and stays in Cloudflare's edge cache. A new report gets a new URL, so X shows the new score instead of a stale one, since X caches card images by URL.
- **A missing image is rendered on request,** stored in R2, then served the same way.
- **Tags:** `twitter:card = summary_large_image`, at 1200×630.

**Which design:** draw these concepts as real 1200×630 images with the same renderer, then compare them:
- **A. The strip:** the big score, plus your marker among the dots of similar repos, "faster than N% of medium repos". Reuses section 4.
- **B. The receipt:** a tall receipt in the CommitScore style. Line items: PR wait, flakes, CI minutes per merged PR, then a total.
- **C. The race:** your repo against 4 similar repos as horizontal wait bars, with yours lit.
- **D. A replay still:** the frame of your run's timeline where the slowest shard finishes alone.

## Tracking repos, adoption and improvement

Agreed 18 Nov: keep track of every repo checked on the site, and later see which ones adopted ci-doctor and whether they improved.

**Record every check.** In D1:
- `repos`: first seen, last checked, how many times it was checked, and the last report.
- `checks`: the repo, when, and how the check arrived: pasted, a leaderboard click, or the nightly refresh. No people: no IPs or accounts are stored beyond the rate limiter's short window.
- `reports`: every report, dated (already planned).
- `adoption`: the repo, the signal, when it was first seen, and a link to the evidence.

**Re-check tracked repos on a schedule.** The nightly Cron Trigger refreshes repos checked in the last 90 days, oldest first, with leftover quota. Each repo's history then shows its trend without anyone pasting it again.

**Detect adoption from public signals**, cheapest first:
1. **A ci-doctor marker in the repo.** Have ci-doctor's prompt leave one, such as a `.ci-doctor.json` with the playbook version, or a `ci-doctor` comment in the files it generates. This is a change to the `ci-doctor` skill, and it should be open about it: the marker is how a repo's history page shows "adopted v0.1.0 on <date>".
2. **The README badge** linking to the site.
3. **ci-doctor's template files,** such as the selection planner, the progress file or `test-groups`, found in the tree.
4. **Commits or PRs that mention ci-doctor** (GitHub search).
5. **"Copy prompt" clicks on that repo's report:** intent to adopt, not adoption.

**Show improvement:**
- **Each repo's history:** score, p50 and p90 over time, with the adoption date marked, and the before-and-after card below.
- **Across repos:** adopters against similar non-adopters over the same weeks. That's the honest measure of whether ci-doctor works, and dated findings from it can go on the findings page.
- **Later, opt-in:** owners can ask to be notified when their score moves.

### Before and after

Agreed 19 Nov: a repo's history page compares its CI before a change with after it, and its card is the shareable proof.

- **The split.** When ci-doctor's marker is in the repo, the split is the commit that added it, and the page says "since adopting ci-doctor". Otherwise the visitor picks a date or a merged PR. That works for any CI change, not only ci-doctor's, and only the marker names ci-doctor. The card names neither: it says how many days it's been.
- **"Before" needs no earlier check.** It's computed from the Actions run history before the split (the runs API filters by `created`), so a repo that was never checked still gets one.
- **Each side is its own fixed window** of PR runs, the same length either side of the split, never "the latest 1,000 runs": on the busiest repos 1,000 runs cover under a day.
- **A minimum sample each side.** Until "after" has it, the page says "collecting, 12 of N runs" and draws no card. N isn't measured yet: choose it from how much a repo's p50 moves between quiet weeks with nothing changed.
- **The page shows the evidence:** the split's date or PR, both windows and their run counts, so a quiet week can't pass for a fix. The card stays to days and minutes saved, and draws only once both sides have their minimum.
- **Bringing people back.** ci-doctor's sign-off ends with "in a week, see your before and after at ci-doctor.ref0.dev/owner/repo/history". This is a change to the `ci-doctor` skill, beside the marker.
- **For launch,** run ci-doctor on one or two slow open-source repos with their maintainers a couple of weeks ahead, and put the real numbers on this card and on the home card in place of their examples.

It's drawn by `history` in `card/render.mjs` (`cd card && node render.mjs history`), with the made-up `pip/garden` until a real adopter exists. Home and history share `beforeAfter`.

## Private repos

Agreed 19 Nov: the site checks public repos only. Private and local repos get the local command, at launch, since home offers it under the paste box. Signing in to the site comes after launch.

**1. A local command, at launch.** Ship the scorer in the `@ref0/ci-doctor` npm package (decided 19 Nov), as `npx @ref0/ci-doctor`, run on the person's machine with their own `gh` sign-in. Nothing about the repo leaves the machine: no sign-in to the site, no stored report. `score.ts` already runs this way, so it's mostly packaging. ref0 owns the `@ref0` scope, so the name is ours. For "Top N% of <size> repos", it may send only the score and the size class, anonymously. ci-doctor's agent already runs in the repo, so it can score before and after with the same command.

**2. The App install, after launch, once people ask for it on the site.**
- "Sign in with GitHub" through the ref0-ci-doctor App, then install it on chosen repos, read only: Actions (runs, jobs, logs), contents (the tree, for lines), metadata and pull requests.
- A report is shown only to someone whose own GitHub token can see the repo. Private reports get no public page, no leaderboard row and nothing crawlable.
- Standing is still among public repos of the size class. Sharing is the owner's choice, and the card can hide the name: "a private repo · 2.1M lines".
- Each installation has its own rate limit, so private repos don't draw on the public quota.
- **Logs are the risk.** The 1–3 job logs a check downloads can hold code, paths or secrets. Read them in memory and keep only the derived numbers. Record this threat before building.

## Architecture on Cloudflare

The scarce resource is GitHub API quota, not Cloudflare compute. Design for both: fast pages, and few GitHub calls.

```
  browser ──► Worker (TanStack Start, SSR) ──► edge cache (24 h per report)
                 │
                 ├─ D1: one row per report: repo, date, score, parts, size, lines, p50 …
                 │      recent repos, leaderboard, percentiles, similar repos: all SQL
                 ├─ R2: full report JSON + Markdown + OG image, dated, kept for history
                 └─ Durable Object, one per repo: runs the scoring once
                        ├─ many people pasting the same repo share one run
                        ├─ streams progress steps to the loading screen
                        └─ GitHub API (App token; sign-in fallback) + raw.githubusercontent.com
  Cron Trigger, nightly: refresh leaderboard repos with leftover quota
```

**Fast:**
- **Report pages render on the server from the stored report:** one request and no client fetch waterfall. The OG tags are in the head, for X's crawler.
- **Edge cache:** report HTML, JSON and Markdown stay at the edge for 24 h, purged when a repo is re-run. Static assets are hashed and immutable.
- **Little JavaScript:** charts are inline SVG with no chart library. Animation uses `motion`, already in ref0. Fonts are self-hosted subsets, as ref0's apps do.
- **The loading screen** follows the Durable Object's progress steps over SSE or a WebSocket.

**Cheap:**
- **One Worker:** pages, API and OG images.
- **One Durable Object per repo:** it scores once, however many people ask. It hibernates when idle.
- **Storage:** D1 for the queryable summary rows; R2 for the full reports and images, which costs nothing to serve out.
- **GitHub quota:**
  - reports cached 24 h;
  - ETag conditional requests on refresh;
  - workflow files from raw.githubusercontent.com, which isn't counted;
  - a GitHub App token, with "Sign in with GitHub" when it runs out;
  - a rate limit on new runs per IP, using Cloudflare's Rate Limiting binding.
- **OG images** are rendered once per report, when the report is written, and stored in R2.
- **Cost:** the Workers Paid plan's base fee, plus usage. Measure usage after launch and give it as a monthly projection; don't guess it now.
- **Before building:** check the Workers limits against a scoring run's subrequests (about 30–60 API calls plus 1–3 log downloads) and the CPU time for parsing logs.

**The scorer becomes a module.** `score.ts`'s logic moves into a package with a fetch-based GitHub client and a pluggable cache. The Worker's Durable Object runs it, and the same module runs as a command-line script for batch calibration runs.

## Building

- **Use React, with `@ref0/ui`'s components, blocks and brand kit.** `@ref0/ui` is private and unpublished, so the site belongs in the ref0 monorepo as a new app, beside `apps/brand` and `apps/web`. It then gets the library's source, ref0's skills, CI and Workers Builds.
  - Use TanStack Start on Workers, like `apps/web`.
  - Its infrastructure (D1, R2, the Durable Object, the cron) goes in the `infra` Alchemy stack.
  - When the app is added, a maintainer updates the Workers Builds trigger paths, as ref0's AGENTS.md says.
  - **Decided 18 Nov:** the site goes in the ref0 monorepo.
- **ref0's UI skills to use:**
  - `brand`: the lockup, voice and the X card;
  - `ui-design`, `ui-principles` and `ui-component`: screens and components;
  - `animate` and `animation-review`: the score count-up, the bars and the replay;
  - `break-ui`: worst-case repos, such as no CI, one job or 500 jobs;
  - `inspect-layout`: layout at each width;
  - `design-review`: the landing and report pages;
  - `web-perf`: Core Web Vitals.
- **Cloudflare skills:** `cf-workers-best-practices`, `cf-durable-objects` and `cf-wrangler`.
- **The logo** is the README lockup in `ref-0/ci-doctor/assets/`.
- **The scorer** already produces everything a report shows, except the cross-repo comparisons, which need the stored reports in D1.
