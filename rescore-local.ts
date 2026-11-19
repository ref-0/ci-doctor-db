// Re-scores every repo's newest stored report with the published scorer's current scoreOf (scorer.ts), from the inputs the report saved.
// No API calls. Writes a new file beside the old one, <date>_rescored.json, which sorts after <date>.json and before
// any later day's report, so the old score stays as history and readers that take the newest file get the new one.
// Usage: node rescore-local.ts [--dry]   (REPORTS=<dir> to re-score the reports there)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectedMinutesPerMergedPr, expectedWait, scoreOf } from './scorer.ts';

const REPORTS = process.env.REPORTS ?? join(import.meta.dirname, 'reports');
const dry = process.argv.includes('--dry');
const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN);
const r1 = (x: number) => Math.round(x * 10) / 10;

let changed = 0;
let same = 0;
let unscored = 0;
for (const dir of readdirSync(REPORTS)) {
  const files = readdirSync(join(REPORTS, dir)).filter((f) => f.endsWith('.json')).sort();
  const newest = files.at(-1);
  if (!newest) continue;
  const report = JSON.parse(readFileSync(join(REPORTS, dir, newest), 'utf8'));
  if (report.score == null) {
    unscored++;
    continue;
  }

  const { score, parts, detail } = scoreOf({
    p50: n(report.wait.p50),
    p90: n(report.wait.p90),
    linesOfCode: report.profile.linesOfCode,
    passedOnRerunRate: n(report.wait.passedOnRerunRate),
    mainRedRate: n(report.main.redRate),
    minutesPerMergedPr: n(report.efficiency.jobMinutesPerMergedPr),
    runsPerMergedPr: n(report.profile.runsPerMergedPr),
    setupShare: n(report.jobs?.setupShare),
    queueP90Sec: n(report.jobs?.queueP90Sec),
    shardIdleTail: n(report.jobs?.shard?.idleTail),
  });
  if (score === report.score && JSON.stringify(detail) === JSON.stringify(report.detail)) {
    same++;
    continue;
  }

  changed++;
  console.log(`${report.repo.padEnd(44)} ${String(report.score).padStart(3)} -> ${String(score).padStart(3)}`);
  if (dry) continue;
  const out = {
    ...report,
    score,
    parts,
    detail,
    rescored: { from: newest, scoreWas: report.score, on: new Date().toISOString().slice(0, 10), by: 'rescore-local.ts' },
    efficiency: { ...report.efficiency, expectedWait: r1(expectedWait(report.profile.linesOfCode)), expectedMinutesPerMergedPr: r1(expectedMinutesPerMergedPr(report.profile.linesOfCode)) },
  };
  const base = newest.replace(/(_rescored)?\.json$/, '');
  writeFileSync(join(REPORTS, dir, `${base}_rescored.json`), JSON.stringify(out, null, 1));
}
console.log(`\n${changed} re-scored, ${same} unchanged, ${unscored} unscored left alone${dry ? ' (dry run: nothing written)' : ''}`);
