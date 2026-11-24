// Publishing: every report under reports/ that origin/main doesn't have yet, as one data commit pushed to main.
// The commit is made in a worktree of its own on origin/main, so nothing else on the checkout's branch (a code
// commit not yet through a PR, say) is ever pushed with it. A report it can't publish stays where it is, and the
// next night publishes it.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { childEnv } from './env.ts';

export const IDENTITY = ['-c', 'user.name=mihar-22', '-c', 'user.email=14304599+mihar-22@users.noreply.github.com'];
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

const git = (dir: string, ...a: string[]) =>
  execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() }).trim();
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

// The report files on origin/main, after fetching it, as reports/<owner>__<repo>/<file>.json.
export function publishedReports(root: string): Set<string> {
  git(root, 'fetch', '-q', 'origin', 'main');
  return new Set(git(root, 'ls-tree', '-r', '--name-only', 'origin/main', '--', 'reports').split('\n'));
}

// The reports origin/main doesn't have, after fetching it.
export function unpublished(root: string): string[] {
  const published = publishedReports(root);
  return onDisk(root).filter((p) => !published.has(p));
}

export function publish(opts: { root: string; scratch: string; date: string; push: boolean; log: (s: string) => void }): string {
  const { root, scratch, date, push, log } = opts;
  let files: string[];
  try {
    files = unpublished(root);
  } catch (e) {
    return `publish: couldn't read origin/main (${why(e)}); nothing pushed`;
  }
  if (!files.length) return 'publish: every report is on origin/main';
  if (!push) return `publish: ${files.length} reports not on origin/main yet; not pushed (--push publishes them)`;

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
    const message = `Reports: ${files.length} checks, published ${date}\n\n${TRAILER}`;
    git(wt, ...IDENTITY, 'commit', '-q', '-m', message);
    sha = git(wt, 'rev-parse', '--short', 'HEAD');
    git(wt, 'push', '-q', 'origin', 'HEAD:main');
  } catch (e) {
    log(`publish: ${why(e)}`);
    return `publish: ${files.length} reports not pushed (${why(e)}); the next night tries again`;
  } finally {
    try {
      git(root, 'worktree', 'remove', '--force', wt);
    } catch {
      rmSync(wt, { recursive: true, force: true });
      git(root, 'worktree', 'prune');
    }
  }

  return `publish: ${files.length} reports pushed to main as ${sha}${catchUp(root, files, log)}`;
}

// The checkout's main, when it has nothing of its own, fast-forwarded to what was pushed. Its copies of the reports
// are untracked and would block the merge, so they're removed first, and only when each is byte for byte the pushed
// one; if the merge fails they're put back from origin/main.
function catchUp(root: string, files: string[], log: (s: string) => void): string {
  try {
    git(root, 'fetch', '-q', 'origin', 'main');
    if (git(root, 'branch', '--show-current') !== 'main') return '';
    try {
      git(root, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main');
    } catch {
      return "; the checkout's main has commits of its own, so it wasn't fast-forwarded";
    }
    for (const f of files) if (git(root, 'hash-object', f) !== git(root, 'rev-parse', `origin/main:${f}`)) return `; ${f} differs from the pushed copy, so the checkout wasn't fast-forwarded`;
    for (const f of files) rmSync(join(root, f));
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
