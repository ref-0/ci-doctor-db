// Scores repos with the published scorer (scorer.ts) and stores each report as reports/<owner>__<repo>/<date>.json,
// the object `ci-doctor --json` prints. It reads with GH_TOKEN, which batch.sh sets to the App's token (token.ts).
// Usage: GH_TOKEN=$(node token.ts) node score-repos.ts owner/repo [owner/repo ...] [--days 7]
//   REPORTS=<dir> stores the reports there instead.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scoreRepo } from './scorer.ts';

const REPORTS = process.env.REPORTS ?? join(import.meta.dirname, 'reports');
const args = process.argv.slice(2);
const days = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : 7;
const repos = args.filter((a, i) => a.includes('/') && args[i - 1] !== '--days');

for (const repo of repos) {
  try {
    const r = scoreRepo(repo, { days, token: process.env.GH_TOKEN || undefined });
    const dir = join(REPORTS, repo.replace('/', '__'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${r.date}.json`), JSON.stringify(r, null, 1));
    console.log(`== ${repo}  score ${r.score}  ${JSON.stringify(r.parts)}  (${r.read.calls} API calls, ${r.window.days} days, ${r.window.runs}${r.window.truncated ? ` of ${r.window.runsInPeriod}` : ''} runs)`);
  } catch (e) {
    console.log(`== ${repo}  failed: ${(e as Error).message.split('\n')[0]}`);
    if (process.env.DEBUG) console.error(e);
  }
}
