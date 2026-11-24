// Re-scores every repo's newest stored report with the published scorer's current scoreOf (scorer.ts), from the inputs the report saved.
// No API calls. Writes a new file beside the old one, <date>_rescored.json, which sorts after <date>.json and before
// any later day's report, so the old score stays as history and readers that take the newest file get the new one.
// A report saved before the scorer counted vCPU-minutes and setup minutes a job doesn't hold those inputs, so it is
// left alone and counted: only a new measure can score it again. A report saved before the export graph counted its
// undecided entries can't say its package and task graphs are clean, so a clean count there is taken as unknown.
// Usage: node rescore-local.ts [--dry]   (REPORTS=<dir> to re-score the reports there)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { band, expectedMinutesPerMergedPr, expectedVcpuMinutesPerMergedPr, expectedWait, grade, inputsOf, scoreOf } from './scorer.ts';

const REPORTS = process.env.REPORTS ?? join(import.meta.dirname, 'reports');
const dry = process.argv.includes('--dry');
const r1 = (x: number) => Math.round(x * 10) / 10;

let changed = 0;
let same = 0;
let unscored = 0;
let older = 0;
for (const dir of readdirSync(REPORTS)) {
  const files = readdirSync(join(REPORTS, dir)).filter((f) => f.endsWith('.json')).sort();
  const newest = files.at(-1);
  if (!newest) continue;
  const report = JSON.parse(readFileSync(join(REPORTS, dir, newest), 'utf8'));
  if (report.score == null) {
    unscored++;
    continue;
  }
  if (typeof report.efficiency?.vcpuMinutesPerMergedPr !== 'number') {
    older++;
    continue;
  }

  const inputs = inputsOf(report);
  if (typeof report.graphs?.exports?.count?.undecided !== 'number' && inputs.graphFlags === 0) inputs.graphFlags = NaN;

  const { score, parts, detail } = scoreOf(inputs);
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
    grade: grade(score),
    band: band(score),
    parts,
    detail,
    rescored: { from: newest, scoreWas: report.score, on: new Date().toISOString().slice(0, 10), by: 'rescore-local.ts' },
    efficiency: {
      ...report.efficiency,
      expectedWait: r1(expectedWait(report.profile.linesOfCode, inputs.language)),
      expectedMinutesPerMergedPr: r1(expectedMinutesPerMergedPr(report.profile.linesOfCode)),
      expectedVcpuMinutesPerMergedPr: r1(expectedVcpuMinutesPerMergedPr(report.profile.linesOfCode)),
    },
  };
  const base = newest.replace(/(_rescored)?\.json$/, '');
  writeFileSync(join(REPORTS, dir, `${base}_rescored.json`), JSON.stringify(out, null, 1));
}
console.log(`\n${changed} re-scored, ${same} unchanged, ${unscored} unscored left alone, ${older} saved before the scorer counted vCPU-minutes and left for a new measure${dry ? ' (dry run: nothing written)' : ''}`);
