// One check, in its own process so a hung read can be timed out: the published scorer (scorer.ts) on one repo,
// with the token in GH_TOKEN, printing the report as JSON. A failure prints its reason on stderr and exits 1.
// Usage: GH_TOKEN=... node loop/check.ts owner/repo [--days 7]
import { scoreRepo } from '../scorer.ts';

const [repo] = process.argv.slice(2).filter((a) => a.includes('/'));
const i = process.argv.indexOf('--days');
const days = i === -1 ? 7 : Number(process.argv[i + 1]);

try {
  const report = scoreRepo(repo, { days, token: process.env.GH_TOKEN || undefined });
  process.stdout.write(JSON.stringify(report));
} catch (e) {
  process.stderr.write(String((e as Error).message ?? e).split('\n')[0]);
  process.exit(1);
}
