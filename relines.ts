// Recounts lines of code in stored reports from the file trees the scorer cached, with the scorer's own rules,
// for reports written before lines came from the tree. No API calls: a report whose tree isn't cached is left alone.
// Usage: node relines.ts
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BYTES_PER_LINE, CODE_EXT, MAX_SOURCE_FILE, SKIP, sizeClass } from './score.ts';

const HERE = import.meta.dirname;
const fromCache = (path: string) => {
  const file = join(HERE, 'cache', createHash('sha1').update(`api:${path}`).digest('hex'));
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
};

let changed = 0;
let missing = 0;
for (const dir of readdirSync(join(HERE, 'reports'))) {
  const file = join(HERE, 'reports', dir, readdirSync(join(HERE, 'reports', dir)).sort().at(-1)!);
  const report = JSON.parse(readFileSync(file, 'utf8'));
  if (report.profile.linesFrom) continue;

  const meta = fromCache(`repos/${report.repo}`);
  const tree = meta && fromCache(`repos/${report.repo}/git/trees/${meta.default_branch}?recursive=1`);
  if (!tree?.tree || tree.truncated) {
    missing++;
    continue;
  }

  const bytes = tree.tree
    .filter((b: any) => b.type === 'blob' && CODE_EXT.test(b.path) && !SKIP.test(b.path) && (b.size ?? 0) <= MAX_SOURCE_FILE)
    .reduce((a: number, b: any) => a + (b.size ?? 0), 0);
  if (!bytes) {
    missing++;
    continue;
  }
  const before = report.profile.linesOfCode;
  report.profile.linesOfCode = Math.round(bytes / BYTES_PER_LINE);
  report.profile.linesFrom = 'tree';
  report.size = sizeClass(report.headsPerWeek ?? 0, report.profile.linesOfCode);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  changed++;
  if (before / report.profile.linesOfCode > 1.5) console.log(`${report.repo}: ${before} → ${report.profile.linesOfCode}`);
}
console.log(`recounted ${changed}, no cached tree ${missing}`);
