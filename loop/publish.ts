// Publishing: every report under reports/ that origin/main doesn't have yet, or has as HEAD has it while this checkout
// changed it, such as one whose practices were read again in place (reread.ts), as one data commit pushed to main.
// The commit is made in a worktree of its own on origin/main, so nothing else on the checkout's branch (a code
// commit not yet through a PR, say) is ever pushed with it. A report it can't publish stays where it is, and the
// next run publishes it.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { childEnv } from './env.ts';

export const IDENTITY = ['-c', 'user.name=mihar-22', '-c', 'user.email=14304599+mihar-22@users.noreply.github.com'];
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

const git = (dir: string, ...a: string[]) =>
  execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() }).trim();
// Each path's blob id as git would store it, in one git call.
const blobIds = (dir: string, paths: string[]): string[] =>
  paths.length
    ? execFileSync('git', ['-C', dir, 'hash-object', '--stdin-paths'], { input: paths.join('\n') + '\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: childEnv() }).trim().split('\n')
    : [];
// The report files at `rev`, by path, with their blob ids.
const reportsAt = (dir: string, rev: string) =>
  new Map(
    git(dir, 'ls-tree', '-r', rev, '--', 'reports')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(l.indexOf('\t') + 1), l.split(/\s+/)[2]!] as const),
  );
const why = (e: unknown) => String((e as { stderr?: string }).stderr ?? '').trim().split('\n').at(-1) || (e as Error).message.split('\n')[0];

// Report files on disk, as paths relative to the checkout: reports/<owner>__<repo>/<file>.json.
function onDisk(root: string): string[] {
  const out: string[] = [];
  const reports = join(root, 'reports');
  if (!existsSync(reports)) return out;
  for (const d of readdirSync(reports, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(reports, d.name))) if (f.endsWith('.json')) out.push(`reports/${d.name}/${f}`);
  }
  return out.sort();
}

// The report files on origin/main, after fetching it, by path (reports/<owner>__<repo>/<file>.json) with their blob ids.
function onMain(root: string): Map<string, string> {
  git(root, 'fetch', '-q', 'origin', 'main');
  return reportsAt(root, 'origin/main');
}

export const publishedReports = (root: string): Set<string> => new Set(onMain(root).keys());

// The reports origin/main doesn't have, and those it has with other content, after fetching it. A report main has is
// told apart by three versions, the checkout's HEAD, the file on disk and main's: it's `changed` when it was changed
// here (disk differs from HEAD) and main still holds what HEAD holds. When only main moved, it's nobody's to publish,
// since the next pull brings main's; when both did, it's `held`, left as it is, and named, so a stale copy never
// overwrites a newer one.
export function pending(root: string): { added: string[]; changed: string[]; held: string[] } {
  const published = onMain(root);
  const files = onDisk(root);
  const head = reportsAt(root, 'HEAD');
  const differ = files.filter((p) => published.has(p));
  const ids = blobIds(root, differ);
  const changed: string[] = [];
  const held: string[] = [];
  differ.forEach((p, i) => {
    if (ids[i] === published.get(p) || ids[i] === head.get(p)) return;
    (published.get(p) === head.get(p) ? changed : held).push(p);
  });
  return { added: files.filter((p) => !published.has(p)), changed, held };
}

export function unpublished(root: string): string[] {
  const { added, changed } = pending(root);
  return [...added, ...changed].sort();
}

export function publish(opts: { root: string; scratch: string; date: string; push: boolean; log: (s: string) => void }): string {
  const { root, scratch, date, push, log } = opts;
  let files: string[];
  let changed: number;
  let held: string;
  try {
    const p = pending(root);
    files = [...p.added, ...p.changed].sort();
    changed = p.changed.length;
    held = p.held.length ? `; ${p.held.length} changed both here and on origin/main since HEAD, left as they are: ${p.held.join(', ')}` : '';
  } catch (e) {
    return `publish: couldn't read origin/main (${why(e)}); nothing pushed`;
  }
  if (!files.length) return held ? `publish: nothing pushed${held}` : 'publish: every report is on origin/main';
  return publishFiles(root, scratch, date, push, log, files, changed) + held;
}

function publishFiles(root: string, scratch: string, date: string, push: boolean, log: (s: string) => void, files: string[], changed: number): string {
  const of = changed ? ` (${changed} changed since origin/main had them)` : '';
  if (!push) return `publish: ${files.length} reports not on origin/main yet${of}; not pushed (--push publishes them)`;

  mkdirSync(scratch, { recursive: true });
  const wt = join(scratch, `publish-${process.pid}`);
  let sha: string;
  try {
    git(root, 'worktree', 'add', '-q', '--detach', wt, 'origin/main');
  } catch (e) {
    return `publish: couldn't make a worktree on origin/main (${why(e)}); ${files.length} reports not pushed`;
  }
  try {
    for (const f of files) {
      mkdirSync(dirname(join(wt, f)), { recursive: true });
      copyFileSync(join(root, f), join(wt, f));
    }
    git(wt, 'add', '--', ...files);
    const what = changed ? `${files.length - changed} checks and ${changed} changed in place` : `${files.length} checks`;
    const message = `Reports: ${what}, published ${date}\n\n${TRAILER}`;
    git(wt, ...IDENTITY, 'commit', '-q', '-m', message);
    sha = git(wt, 'rev-parse', '--short', 'HEAD');
    git(wt, 'push', '-q', 'origin', 'HEAD:main');
  } catch (e) {
    log(`publish: ${why(e)}`);
    return `publish: ${files.length} reports not pushed (${why(e)}); the next run tries again`;
  } finally {
    try {
      git(root, 'worktree', 'remove', '--force', wt);
    } catch {
      rmSync(wt, { recursive: true, force: true });
      git(root, 'worktree', 'prune');
    }
  }

  return `publish: ${files.length} reports pushed to main as ${sha}${of}${catchUp(root, files, log)}`;
}

// The checkout's main, when it has nothing of its own, fast-forwarded to what was pushed. Its copies of the reports
// would block the merge, a new one untracked and a changed one modified, so they're set aside first, and only when
// each is byte for byte the pushed one: a new one removed, a changed one put back as HEAD has it. If the merge fails,
// they're put back from origin/main.
function catchUp(root: string, files: string[], log: (s: string) => void): string {
  try {
    git(root, 'fetch', '-q', 'origin', 'main');
    if (git(root, 'branch', '--show-current') !== 'main') return '';
    try {
      git(root, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main');
    } catch {
      return "; the checkout's main has commits of its own, so it wasn't fast-forwarded";
    }
    const pushed = reportsAt(root, 'origin/main');
    const ids = blobIds(root, files);
    const differs = files.find((f, i) => ids[i] !== pushed.get(f));
    if (differs) return `; ${differs} differs from the pushed copy, so the checkout wasn't fast-forwarded`;
    const tracked = reportsAt(root, 'HEAD');
    const restore = files.filter((f) => tracked.has(f));
    for (const f of files) if (!tracked.has(f)) rmSync(join(root, f));
    if (restore.length) git(root, 'checkout', '-q', 'HEAD', '--', ...restore);
    try {
      git(root, 'merge', '-q', '--ff-only', 'origin/main');
    } catch (e) {
      for (const f of files) writeFileSync(join(root, f), execFileSync('git', ['-C', root, 'show', `origin/main:${f}`]));
      log(`publish: fast-forward failed: ${why(e)}`);
      return "; the checkout couldn't be fast-forwarded (see the log)";
    }
    return '; the checkout is fast-forwarded';
  } catch (e) {
    log(`publish: catching up the checkout failed: ${why(e)}`);
    return '';
  }
}
