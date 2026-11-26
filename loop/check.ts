// One check, in its own process so a hung read can be timed out: the published scorer (scorer.ts) on one repo,
// with the token in GH_TOKEN, printing the report as JSON. With --practices it reads a stored report's practices again
// instead (rereadPractices), and prints that report. A failure prints its reason on stderr and exits 1.
// Usage: GH_TOKEN=... node loop/check.ts owner/repo [--days 7]
//        GH_TOKEN=... node loop/check.ts --practices <report file>
import { readFileSync } from 'node:fs';
import { rereadPractices, scoreRepo } from '../scorer.ts';

const flag = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const [repo] = process.argv.slice(2).filter((a) => a.includes('/') && !a.endsWith('.json'));
const days = flag('--days') === undefined ? 7 : Number(flag('--days'));
const stored = flag('--practices');
const token = process.env.GH_TOKEN || undefined;

try {
  const report = stored ? rereadPractices(JSON.parse(readFileSync(stored, 'utf8')), { token }) : scoreRepo(repo, { days, token });
  process.stdout.write(JSON.stringify(report));
} catch (e) {
  process.stderr.write(String((e as Error).message ?? e).split('\n')[0]);
  process.exit(1);
}
