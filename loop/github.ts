// The measure job's own GitHub reads, all with the ref0-ci-doctor App's token: the quota, and discovery's searches.
// The scorer makes its own reads; these are the ones around it.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { childEnv } from './env.ts';
import { MIN_STARS, type GitHub } from './queue.ts';

const ROOT = join(import.meta.dirname, '..');

// A fresh App installation token from token.ts, which keeps its own key and cache. Never logged.
export function appToken(): string {
  const token = withRetry(() => {
    try {
      return execFileSync('node', [join(ROOT, 'token.ts')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() }).trim();
    } catch (e) {
      throw new Error(`token.ts: ${String((e as { stderr?: string }).stderr ?? '').trim().split('\n').at(-1) || (e as Error).message.split('\n')[0]}`);
    }
  });
  if (!token) throw new Error('token.ts printed no token');
  return token;
}

// A read worth trying again: GitHub's 5xx, or the connection going.
const TRANSIENT = /HTTP 5\d\d|\b50[0-4]\b|connection (reset|refused)|ECONNRESET|ETIMEDOUT|timed? ?out|unexpected EOF|TLS handshake|no such host|network is unreachable/i;
export const isTransient = (message: string) => TRANSIENT.test(message);

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// `fn`, tried again on a transient failure after 2, 4 and 8 seconds.
export function withRetry<T>(fn: () => T, { tries = 4, baseMs = 2_000, sleep = sleepSync, log = (_: string) => {} } = {}): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      const message = (e as Error).message;
      if (attempt >= tries || !isTransient(message)) throw e;
      const wait = baseMs * 2 ** (attempt - 1);
      log(`retrying in ${wait / 1000} seconds after: ${message.split('\n')[0]}`);
      sleep(wait);
    }
  }
}

function gh(token: string, path: string, fields: Record<string, string | number> = {}, method = 'GET'): any {
  return withRetry(() => ghOnce(token, path, fields, method));
}

function ghOnce(token: string, path: string, fields: Record<string, string | number>, method: string): any {
  const args = ['api', '--hostname=github.com', '-X', method, path];
  for (const [k, v] of Object.entries(fields)) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  try {
    const out = execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv({ GH_TOKEN: token, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_TELEMETRY: 'false' }),
    });
    return JSON.parse(out);
  } catch (e) {
    // gh's own message, not the command line, which holds the whole GraphQL query.
    const err = e as { stderr?: string; stdout?: string; message: string };
    const why = String(err.stderr ?? '').trim().split('\n').at(-1) || err.message.split('\n')[0];
    throw Object.assign(new Error(`gh api ${path}: ${why}`), { stdout: err.stdout });
  }
}

// GraphQL answers with data and errors both when some nodes are hidden, such as an org's IP allow list: gh exits 1
// with the data still on stdout, and the hidden nodes come back null.
function graphql(token: string, fields: Record<string, string | number>): any {
  try {
    return gh(token, 'graphql', fields, 'POST').data;
  } catch (e) {
    const stdout = String((e as { stdout?: string }).stdout ?? '');
    try {
      const data = JSON.parse(stdout).data;
      if (data) return data;
    } catch {}
    throw e;
  }
}

export type Quota = { remaining: number; limit: number; reset: number };

// The core limit, which the scorer spends. Reading it spends none.
export function coreQuota(token: string): Quota {
  const core = gh(token, 'rate_limit').resources.core;
  return { remaining: core.remaining, limit: core.limit, reset: core.reset };
}

// GitHub search's language qualifier takes linguist's alias where the name has symbols.
const ALIAS: Record<string, string> = { 'C#': 'csharp', 'C++': 'cpp' };

const SEARCH = `query($q: String!, $after: String) {
  search(query: $q, type: REPOSITORY, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on Repository {
      nameWithOwner isFork isArchived isPrivate
      primaryLanguage { name }
      languages(first: 1) { totalSize }
      pullRequests(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { createdAt } }
    } }
  }
}`;

export function liveGitHub(token: string) {
  const calls = { core: 0, graphql: 0 };
  const cursors = new Map<string, string | null>();

  const api: GitHub = {
    searchRepos(language, since, page) {
      const key = `${language} ${since}`;
      if (page > 1 && !cursors.get(key)) return [];
      const q = `language:${ALIAS[language] ?? language.toLowerCase()} stars:>=${MIN_STARS} pushed:>=${since} fork:false archived:false is:public sort:updated`;
      calls.graphql++;
      const fields: Record<string, string | number> = { query: SEARCH, q };
      if (page > 1) fields.after = cursors.get(key)!;
      const r = graphql(token, fields).search;
      cursors.set(key, r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null);
      return r.nodes
        .filter((n: any) => n?.nameWithOwner)
        .map((n: any) => ({
          repo: n.nameWithOwner,
          fork: n.isFork,
          archived: n.isArchived,
          private: n.isPrivate,
          language: n.primaryLanguage?.name ?? null,
          bytes: n.languages?.totalSize ?? 0,
          prs: (n.pullRequests?.nodes ?? []).filter((p: any) => p.createdAt >= since).length,
        }));
    },
    prRuns(repo, since) {
      calls.core++;
      return gh(token, `repos/${repo}/actions/runs`, { event: 'pull_request', created: `>=${since}`, per_page: 1 }).total_count ?? 0;
    },
  };
  return { api, calls };
}
