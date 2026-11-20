-- The learning loop's store: the score site's D1 tables, in SQLite.
-- D1 runs this file unchanged: no PRAGMAs, no extensions, JSON kept as TEXT.
-- Full report JSON stays in reports/ (the site's R2); a report row names it by `path`.

-- Every repo ever measured. latest_report is the newest report file, scored or not.
CREATE TABLE IF NOT EXISTS repos (
  repo           TEXT PRIMARY KEY,           -- owner/name
  first_seen     TEXT NOT NULL,              -- YYYY-MM-DD of its first check
  last_checked   TEXT NOT NULL,              -- YYYY-MM-DD of its newest check
  times_checked  INTEGER NOT NULL,
  latest_report  TEXT REFERENCES reports(id)
);

-- One row per report file. A rescore of a stored report is its own row, sorting after the report it rescored.
CREATE TABLE IF NOT EXISTS reports (
  id             TEXT PRIMARY KEY,           -- owner/name/<file stem>, e.g. vitejs/vite/2026-11-19_rescored
  repo           TEXT NOT NULL,
  date           TEXT NOT NULL,              -- YYYY-MM-DD the window ends
  seq            INTEGER NOT NULL,           -- 0 for a measured report, 1 for a rescore of it: (date, seq) orders a repo's reports
  path           TEXT NOT NULL,              -- the JSON file, relative to reports/ (R2 key on the site)
  sha256         TEXT NOT NULL,              -- of the file, so a re-import knows nothing changed
  rescored_from  TEXT,                       -- the report id a rescore re-scored
  score_was      INTEGER,                    -- a rescore's previous score

  window_days    REAL,
  window_runs    INTEGER,
  window_truncated INTEGER,

  score          INTEGER,                    -- NULL when unscored
  unscored       TEXT,                       -- why, when unscored
  grade          TEXT,                       -- from the score, on score.ts's current scale
  band           TEXT,
  speed          INTEGER,
  reliability    INTEGER,
  efficiency     INTEGER,

  size           TEXT,                       -- tiny, small, medium, large
  lines          INTEGER,                    -- profile.linesOfCode
  language       TEXT,                       -- the main language, GitHub's largest share
  heads_per_week REAL,
  heads          INTEGER,                    -- PR heads in the window
  wait_p50       REAL,                       -- minutes, PR push to last check
  wait_p75       REAL,
  wait_p90       REAL,
  red_rate       REAL,
  passed_on_rerun_rate REAL,
  main_red_rate  REAL,
  job_minutes_per_merged_pr REAL,
  runs_per_merged_pr REAL,
  setup_share    REAL,
  queue_p90_sec  REAL,
  bot_run_share  REAL,                       -- share of PR runs from bots
  logs_read      INTEGER,                    -- job logs the probe read
  files_timed    INTEGER,                    -- test files with timings parsed from those logs
  api_calls      INTEGER,                    -- GitHub API calls the check took

  -- practices, 0/1 unless named
  workflows         INTEGER,
  cancel_in_progress INTEGER,
  path_filters      INTEGER,
  affected          INTEGER,
  draft_skip        INTEGER,
  merge_queue       INTEGER,
  scheduled         INTEGER,
  dep_cache         INTEGER,
  remote_cache      INTEGER,
  compiler_cache    INTEGER,
  frozen_install    INTEGER,
  shards_configured INTEGER,
  timeouts          INTEGER,
  fast_lint         INTEGER,
  eslint            INTEGER,
  test_results      INTEGER,
  dep_bots_batched  INTEGER,
  agent_rules       INTEGER,
  pre_commit        INTEGER,
  package_manager   TEXT,
  test_runner       TEXT,
  task_runner       TEXT,

  -- The stack, as JSON: the published scorer's report.stack, with languages, packages, workspace, testRunners,
  -- lintFormat, libraries, runners, agentFiles and unknown. A research report has only the first four it shares:
  -- {"languages":[[name,pct]],"packages":{npm,cargo,go,python},"runners":[[provider,jobs]],"agentFiles":[...]}
  stack          TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS reports_repo_order ON reports (repo, date DESC, seq DESC);
CREATE INDEX IF NOT EXISTS reports_cohort ON reports (size, language);
CREATE INDEX IF NOT EXISTS reports_date ON reports (date);

-- When and why each repo was measured. A rescore isn't a check: it re-reads a stored report.
-- An import makes one per measured report no other check names; the measure job makes its own, with an ISO time.
CREATE TABLE IF NOT EXISTS checks (
  repo     TEXT NOT NULL,
  at       TEXT NOT NULL,                    -- YYYY-MM-DD, or an ISO time once the loop records them
  reason   TEXT NOT NULL CHECK (reason IN ('import', 'refresh', 'gap', 'site', 'adoption')),
  scored   INTEGER NOT NULL,
  report   TEXT REFERENCES reports(id),      -- NULL when the check failed before writing one
  error    TEXT,                             -- why it didn't score, or why it failed
  calls    INTEGER,                          -- GitHub API calls it spent; NULL for an import
  PRIMARY KEY (repo, at, reason)
);

CREATE INDEX IF NOT EXISTS checks_at ON checks (at);

-- Public signals that a repo adopted ci-doctor.
CREATE TABLE IF NOT EXISTS adoption (
  repo        TEXT NOT NULL,
  signal      TEXT NOT NULL,                 -- marker, badge, template, mention
  first_seen  TEXT NOT NULL,
  evidence    TEXT NOT NULL,                 -- a link to the file, commit or PR
  PRIMARY KEY (repo, signal)
);

-- Dated claims the loop has made, each with the query that backs it.
CREATE TABLE IF NOT EXISTS findings (
  id        INTEGER PRIMARY KEY,
  date      TEXT NOT NULL,
  claim     TEXT NOT NULL,
  n         INTEGER NOT NULL,
  cohort    TEXT NOT NULL,                   -- e.g. large × TypeScript, or "all"
  query     TEXT NOT NULL                    -- the SQL over this schema that reproduces it
);

CREATE INDEX IF NOT EXISTS findings_date ON findings (date);
