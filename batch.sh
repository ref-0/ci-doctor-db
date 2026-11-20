#!/usr/bin/env bash
# Scores every repo in a CSV's `repo` column, pausing whenever the shared token runs low.
# Usage: batch.sh repos.csv   (skips repos that already have today's report)
# Uses the ref0-ci-doctor GitHub App's own quota (token.ts), not the caller's token, and the published scorer
# (score-repos.ts, through scorer.ts).
set -u
cd "$(dirname "$0")"
KEEP=150
today=$(date -u +%F)
python3 -c "import csv,sys; [print(r['repo']) for r in csv.DictReader(open(sys.argv[1]))]" "$1" | while read -r repo; do
  [ -z "${FORCE:-}" ] && [ -f "${REPORTS:-reports}/${repo/\//__}/$today.json" ] && { echo "skip $repo"; continue; }
  export GH_TOKEN=$(node token.ts)
  while :; do
    read -r left reset < <(gh api rate_limit --jq '.resources.core | "\(.remaining) \(.reset)"')
    [ "$left" -ge "$KEEP" ] && break
    wait=$(( reset - $(date +%s) + 30 ))
    echo "$(date -u +%T) quota $left < $KEEP, waiting ${wait}s"
    sleep "$wait"
  done
  echo "$(date -u +%T) $repo (quota $left)"
  timeout 600 node score-repos.ts "$repo" | grep -E '^== '
done
echo DONE
