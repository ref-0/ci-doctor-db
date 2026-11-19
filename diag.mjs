// For one repo's cached runs: per PR head, every gating run's created/started/updated offsets and event.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
const [repo, since] = process.argv.slice(2);
const runs = [];
for (let page = 1; page <= 10; page++) {
  const path = `repos/${repo}/actions/runs?created=%3E%3D${since}&per_page=100&page=${page}&exclude_pull_requests=true`;
  const f = `cache/${createHash('sha1').update('api:' + path).digest('hex')}`;
  if (!existsSync(f)) break;
  const r = JSON.parse(readFileSync(f, 'utf8')); runs.push(...r.workflow_runs); if (r.workflow_runs.length < 100) break;
}
const pr = runs.filter((r) => r.event.startsWith('pull_request') && r.status === 'completed' && !['skipped','neutral','action_required'].includes(r.conclusion));
const heads = new Map(); for (const r of pr) heads.set(r.head_sha, [...(heads.get(r.head_sha) ?? []), r]);
const m = (a, b) => ((Date.parse(b) - Date.parse(a)) / 60000).toFixed(1);
let shown = 0;
const spans = [...heads.values()].map((rs) => { const t0 = rs.map((r) => r.created_at).sort()[0]; return [Math.max(...rs.map((r) => (Date.parse(r.updated_at) - Date.parse(t0)) / 60000)), rs, t0]; }).sort((a, b) => b[0] - a[0]);
const pick = [spans[0], spans[Math.floor(spans.length / 2)], spans.at(-1)];
for (const [span, rs, t0] of pick) {
  console.log(`\nhead span ${span.toFixed(1)} min, ${rs.length} runs, actor ${rs[0].actor?.login}`);
  for (const r of rs.sort((a, b) => a.created_at.localeCompare(b.created_at)))
    console.log(`  ${r.name.slice(0, 40).padEnd(40)} ${r.event.padEnd(20)} att ${r.run_attempt} ${String(r.conclusion).padEnd(9)} created +${m(t0, r.created_at)} started +${m(t0, r.run_started_at)} done +${m(t0, r.updated_at)}`);
}
console.log('\nworkflows on PRs:', [...new Set(pr.map((r) => r.name))].join(' | '));
