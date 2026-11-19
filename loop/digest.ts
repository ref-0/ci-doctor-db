// Turns digest/YYYY-MM-DD.json into digest/YYYY-MM-DD.md: what changed first, then health, then effects and movers.
// Every number comes from the JSON, with its n. The learn job's agent adds its narrative and proposals in the
// marked place at the end; nothing here writes prose about the numbers.
// Usage: node loop/digest.ts [--out <dir>] [--date YYYY-MM-DD]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_OUT, previousDigest, today, type Digest, type Spread } from './compare.ts';

export const NARRATIVE_START = '<!-- learn: narrative and proposals start -->';
export const NARRATIVE_END = '<!-- learn: narrative and proposals end -->';

const pc = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
const sp = (s: Spread) => `${s.p10 ?? 'n/a'} / ${s.p50 ?? 'n/a'} / ${s.p90 ?? 'n/a'}`;
const signed = (x: number) => (x >= 0 ? `+${x}` : `${x}`);
const delta = (now: number, was: number | undefined) => (was === undefined ? `${now}` : `${now} (${signed(now - was)})`);
const pct = (x: number) => `${x > 0 ? '+' : ''}${Math.round(x * 100)}%`;
const list = (xs: { value: string; n: number }[], limit = 6) =>
  xs.length ? xs.slice(0, limit).map((x) => `${x.n} × ${x.value}`).join(', ') + (xs.length > limit ? `, and ${xs.length - limit} more` : '') : 'none';

function changed(d: Digest['movers']['rows'][number]['changed']): string {
  const parts: string[] = [];
  for (const [kind, fields] of Object.entries(d)) {
    for (const [k, [a, b]] of Object.entries(fields as Record<string, [unknown, unknown]>)) {
      parts.push(`${kind === 'practices' ? '' : `${kind}.`}${k} ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    }
  }
  return parts.length ? parts.join('; ') : 'nothing recorded changed';
}

function sinceLast(d: Digest, prev: Digest | null): string[] {
  if (!prev) return [`- First digest: no earlier one to compare with.`];

  const s = d.score.separation;
  const ps = prev.score.separation;
  const dist = d.score.distribution;
  const pd = prev.score.distribution;
  return [
    `- **Repos** ${delta(d.totals.repos, prev.totals.repos)}, **scored** ${delta(d.totals.scored, prev.totals.scored)}, **reports** ${delta(d.totals.reports, prev.totals.reports)}.`,
    `- **Checks since ${prev.date}:** ${d.probe.checks.n}, of which ${d.probe.checks.failed.n} failed and ${d.probe.checks.unscored.n} unscored.`,
    `- **Separation:** fast at 75+ ${pc(ps.fast.share)} → ${pc(s.fast.share)} (n ${s.fast.n}); slow under 50 ${pc(ps.slow.share)} → ${pc(s.slow.share)} (n ${s.slow.n}).`,
    `- **Scores** p10 / p50 / p90 ${sp(pd)} → ${sp(dist)} (n ${pd.n} → ${dist.n}).`,
    `- **Test timings parsed:** ${pc(prev.probe.test_timings.share)} → ${pc(d.probe.test_timings.share)} of scored repos.`,
    `- **Movers:** ${d.movers.rows.length} (was ${prev.movers.rows.length}); noise n ${delta(d.noise.n, prev.noise.n)}.`,
  ];
}

export function render(d: Digest, prev: Digest | null): string {
  const p = d.probe;
  const t = p.test_timings;
  const s = d.score;
  const ranked = d.effects.rows.filter((r) => r.ranked).slice(0, 5);
  const out: string[] = [];

  out.push(`# ci-doctor loop digest, ${d.date}`, '');
  out.push(
    `${d.totals.repos} repos, ${d.totals.scored} scored, ${d.totals.reports} reports (${d.totals.measured} measured, the rest rescores). Every number below is from \`digest/${d.date}.json\`.`,
    '',
  );

  out.push(`## Since ${prev ? `the ${prev.date} digest` : 'last time'}`, '', ...sinceLast(d, prev), '');

  out.push('## Health of the probe', '');
  out.push(
    `- **Checks${p.checks.since ? ` since ${p.checks.since}` : ', all so far'}:** ${p.checks.n}. Failed: ${p.checks.failed.n}${p.checks.failed.n ? ` (${list(p.checks.failed.why)})` : ''}. Unscored: ${p.checks.unscored.n}${p.checks.unscored.n ? ` (${list(p.checks.unscored.why)})` : ''}.`,
    `- **Test timings parsed:** ${t.timed} of ${t.n} scored repos (${pc(t.share)}); logs read for ${t.logs_read}.`,
    `  - By test runner: ${t.by_test_runner.map((r) => `${r.value} ${r.timed}/${r.n}`).join(', ')}.`,
    `  - By language: ${t.by_language.filter((r) => r.n >= 5).map((r) => `${r.value} ${r.timed}/${r.n}`).join(', ') || 'none with 5+ repos'}${t.by_language.some((r) => r.n < 5) ? `; ${t.by_language.filter((r) => r.n < 5).length} languages under 5 repos left out` : ''}.`,
    `- **Runner labels not recognised:** ${p.unrecognised.runner_labels.length ? p.unrecognised.runner_labels.map((r) => `\`${r.label}\` (${r.repos})`).join(', ') : 'none'}.`,
    `- **No test runner detected:** ${p.unrecognised.no_test_runner.n} of ${t.n} scored repos: ${list(p.unrecognised.no_test_runner.by_language)}.`,
    `- **Windows:** ${p.windows.truncated} of ${p.windows.n} hit the 1,000-run cap; ${p.windows.under_3_days} cover under 3 days and ${p.windows.under_1_day} under 1 (days p10 / p50 / p90 ${sp(p.windows.days)}).`,
    `- **Bot share of PR runs:** p10 / p50 / p90 ${pc(p.bot_run_share.p10)} / ${pc(p.bot_run_share.p50)} / ${pc(p.bot_run_share.p90)} (n ${p.bot_run_share.n}), counted in every score.`,
    `- **API calls per check:** p50 ${p.api_calls.p50}, p90 ${p.api_calls.p90} (n ${p.api_calls.n}).`,
    '',
  );

  out.push('## Health of the score', '');
  out.push(
    `- **Separation on trusted labels:** fast at 75+ ${s.separation.fast.at75}/${s.separation.fast.n} (${pc(s.separation.fast.share)}); slow under 50 ${s.separation.slow.under50}/${s.separation.slow.n} (${pc(s.separation.slow.share)}).`,
    `- **Misses:** ${s.separation.misses.length ? s.separation.misses.map((m) => `${m.repo} (${m.label}, ${m.score}, p50 ${m.wait_p50} min)`).join(', ') : 'none'}.`,
    `- **Scores:** p10 / p50 / p90 ${sp(s.distribution)}, n ${s.distribution.n}; ≥75 ${s.distribution.bands.at75}, 50–74 ${s.distribution.bands.from50to74}, <50 ${s.distribution.bands.under50}${s.previous ? `; previous ${sp(s.previous)}, n ${s.previous.n}` : '; no previous digest'}.`,
    `- **Noise:** ${d.noise.n} unchanged repos; |p50 change| p50 ${pc(d.noise.wait_p50_change.p50)}, p90 ${pc(d.noise.wait_p50_change.p90)}; |stored score change| p50 ${d.noise.score_change.p50 ?? 'n/a'}, p90 ${d.noise.score_change.p90 ?? 'n/a'} (n ${d.noise.score_change.n}; reports before a rescore keep their own scale). Movers threshold ${pc(d.noise.threshold)}${d.noise.placeholder ? `, a placeholder until n reaches 20` : ', from the noise p90'}.`,
    '',
  );

  out.push('## Practice effects, top 5', '');
  out.push(
    `Within cohorts of ${d.effects.min_cohort}+ (size × language), p50 wait with the practice against without it, ranked by the size of the gap among those with ${d.effects.min_side_to_rank}+ repos each side. **Correlations, not causes.**`,
    '',
  );
  if (ranked.length) {
    out.push('| Cohort | Practice | With: p50 min (n) | Without: p50 min (n) | Ratio |', '| --- | --- | --- | --- | --- |');
    for (const r of ranked) out.push(`| ${r.size} × ${r.language} (${r.cohort_n}) | ${r.practice} | ${r.with.wait_p50} (${r.with.n}) | ${r.without.wait_p50} (${r.without.n}) | ${r.ratio} |`);
  } else out.push('No cohort has enough repos on both sides yet.');
  out.push('');

  out.push('## Movers', '');
  if (d.movers.rows.length) {
    for (const m of d.movers.rows) {
      out.push(`- **${m.repo}** ${m.from} → ${m.to}: p50 ${m.wait_p50[0]} → ${m.wait_p50[1]} min (${pct(m.change)}), score ${m.score[0]} → ${m.score[1]}. Changed: ${changed(m.changed)}.`);
    }
  } else out.push(`None: ${d.movers.note}.`);
  out.push('');

  out.push('## Cohorts', '');
  out.push(`${d.cohorts.rows.length} cohorts kept; ${d.cohorts.skipped.cohorts} cohorts (${d.cohorts.skipped.repos} repos) under ${d.cohorts.min_n} skipped. p10 / p50 / p90.`, '');
  out.push('| Cohort | n | Wait p50 (min) | Score | Job min per merged PR |', '| --- | --- | --- | --- | --- |');
  for (const c of d.cohorts.rows) out.push(`| ${c.size} × ${c.language} | ${c.n} | ${sp(c.wait_p50)} | ${sp(c.score)} | ${sp(c.job_minutes_per_merged_pr)} |`);
  out.push('');

  out.push('## Adoption', '', `${d.adoption.n} rows: ${d.adoption.note}.`, '');

  out.push('## Narrative and proposals', '', NARRATIVE_START, '_The learn job writes here._', NARRATIVE_END, '');
  return out.join('\n');
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (import.meta.main) {
  const date = arg('--date') ?? today();
  const out = arg('--out') ?? DEFAULT_OUT;
  const digest = JSON.parse(readFileSync(join(out, `${date}.json`), 'utf8')) as Digest;

  const file = join(out, `${date}.md`);
  writeFileSync(file, render(digest, previousDigest(out, date) as Digest | null));
  console.log(file);
}
