// Cache retention: deletes raw API responses and logs under cache/ last changed more than 14 days ago, then any
// folder that leaves empty. Reports, in reports/, are kept forever and never looked at here.
// It works only inside this checkout's own cache/, by its real path, and never follows a symlink: a symlink is left
// alone, and a cache/ that is itself a symlink is refused.
// Usage: node loop/prune.ts --dry-run [--days 14] [--cache <dir under cache/>]   lists what it would delete
//        node loop/prune.ts [--days 14]                                          deletes it
import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, sep } from 'node:path';

export const DEFAULT_CACHE = join(import.meta.dirname, '..', 'cache');
export const KEEP_DAYS = 14;

// `dir` must be `root` or under it, by real paths, and `root` a real folder, not a symlink.
export function checkPruneDir(dir: string, root: string = DEFAULT_CACHE): string {
  if (!lstatSync(root).isDirectory()) throw new Error(`${root} is not a folder (a symlink isn't pruned)`);
  const realRoot = realpathSync(root);
  const real = realpathSync(dir);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error(`refusing to prune ${dir}: it isn't ${root} or under it`);
  return real;
}

export function checkDays(days: number): number {
  if (!Number.isFinite(days) || days <= 0) throw new Error(`--days takes a positive number of days, not ${days}`);
  return days;
}

export function prune(dir: string, { root = DEFAULT_CACHE, days = KEEP_DAYS, now = Date.now(), dryRun = true } = {}) {
  const start = checkPruneDir(dir, root);
  const cutoff = now - checkDays(days) * 86_400_000;
  const result = { files: 0, bytes: 0, kept: 0, keptBytes: 0, oldest: null as number | null };

  const walk = (d: string): boolean => {
    let empty = true;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) {
        empty = false;
        continue;
      }
      if (e.isDirectory()) {
        if (walk(p) && !dryRun) rmdirSync(p);
        else empty = false;
        continue;
      }
      const st = lstatSync(p);
      if (st.mtimeMs >= cutoff) {
        result.kept++, (result.keptBytes += st.size), (empty = false);
        continue;
      }
      result.files++;
      result.bytes += st.size;
      result.oldest = Math.min(result.oldest ?? st.mtimeMs, st.mtimeMs);
      if (!dryRun) unlinkSync(p);
      else empty = false;
    }
    return empty;
  };
  walk(start);
  return result;
}

export const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;

export function summary(r: ReturnType<typeof prune>, dryRun: boolean, days = KEEP_DAYS) {
  const oldest = r.oldest === null ? '' : `, oldest ${new Date(r.oldest).toISOString().slice(0, 10)}`;
  return `prune: ${dryRun ? 'would delete' : 'deleted'} ${r.files} files (${gb(r.bytes)}) older than ${days} days${oldest}; keeps ${r.kept} (${gb(r.keptBytes)})`;
}

if (import.meta.main) {
  const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
  const dryRun = process.argv.includes('--dry-run');
  const days = Number(arg('--days') ?? KEEP_DAYS);
  try {
    console.log(summary(prune(arg('--cache') ?? DEFAULT_CACHE, { days, dryRun }), dryRun, days));
  } catch (e) {
    console.error(`prune: ${(e as Error).message}`);
    process.exit(2);
  }
}
