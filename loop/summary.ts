// Prints what loop.db holds: counts, cohorts by size class × main language, and named repos' latest scores.
// Usage: node loop/summary.ts [--db <file>] [owner/repo ...]
import { cohorts, counts, DEFAULT_DB, latestOf, open } from './db.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--db');
const dbPath = at === -1 ? DEFAULT_DB : args.splice(at, 2)[1];
const named = args.length ? args : ['vitejs/vite', 'astral-sh/ruff', 'facebook/react', 'vercel/next.js', 'microsoft/aspire'];
const db = open(dbPath);

const c = counts(db);
console.log(`${c.repos} repos, ${c.reports} reports, ${c.checks} checks; latest report scored for ${c.scored}, unscored for ${c.unscored}`);

console.log('\ncohorts (latest scored report), score p10 / p50 / p90');
for (const r of cohorts(db)) console.log(`  ${r.size.padEnd(7)} ${r.language.padEnd(11)} ${String(r.n).padStart(3)}   ${r.p10} / ${r.p50} / ${r.p90}`);

console.log('\nlatest scores');
for (const repo of named) {
  const r = latestOf(db, repo) as { id: string; score: number | null } | undefined;
  console.log(`  ${repo.padEnd(18)} ${r ? `${r.score ?? 'unscored'}  (${r.id})` : 'not in loop.db'}`);
}
db.close();
