# Well-run CI research

- Searched the web for public CI write-ups on faster runners, caches, changed-path checks, sharding, and merge queues. Looked across Go, Python, Rust, TypeScript, and Bazel projects from small libraries through large monorepos.
- Used kagent's benchmark, Apache Airflow's runner migration post, the Rust Compiler Development Guide, and project-owned CI docs and workflows. Workflow links in the CSV point to the revisions inspected.
- Used nine batched GitHub GraphQL queries for canonical repo names, public and original status, push dates, stars, language bytes, and default branch workflow listings. Excluded the inbox and all six previously scored repos by case-insensitive canonical name.
- Checked push recency on 2026-11-19 UTC (Nov 18 Pacific). Used the GitHub Actions `pull_request` run count with `created>=2026-11-12` and `per_page=1`, as specified in the brief. Kept the returned `total_count` verbatim, including ten values of 2,500.
- Made 68 REST requests, including 60 Actions run-count requests and eight rate-limit reads. Made zero GitHub Search API requests. Stopped REST checks when the shared core balance reached 1,496.
- Left out further leads without a verified count, including Celery despite a Blacksmith case study, and candidates whose Actions runs primarily cover metadata while another system runs the PR tests.
- Language lists use the top three languages by GitHub bytes. The size hint uses total language bytes divided by 30 and rounded. The speed labels are hypotheses from the cited practices. Runner or workload improvements reported by maintainers can cover only part of the CI pipeline.
