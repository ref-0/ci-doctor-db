// The check on a pull request that submits a report, from `npx @ref0/ci-doctor --submit`. The workflow
// (.github/workflows/submission.yml) runs this file from the default branch, never from the pull request, and treats
// the pull request as data: it reads the changed files and the one file's content through the API, runs the scorer
// package's smokeCheck on it, and asks GitHub once whether the repo is public. It doesn't score the repo again.
// It comments what it found and sets the `submission` status on the pull request's head commit: success is what a
// merger can rely on. A pull request that changes anything else isn't a submission, gets no status, and is left for a
// person.
// Usage, in the workflow: GH_TOKEN=... SCORER=<the package's dist/index.js> node submission/check.ts
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CONTEXT = 'submission';
// GitHub logins are letters, digits and hyphens, so the first `__` ends the owner.
const PATH = /^reports\/([A-Za-z0-9-]+)__([\w.-]+)\/(\d{4}-\d{2}-\d{2})\.json$/;

export interface Api {
  /** A GET's JSON answer, or undefined on a 404. */
  get(path: string): Promise<any>;
  /** A file's raw bytes at a commit, as text. */
  raw(path: string, ref: string): Promise<string>;
  post(path: string, body: unknown): Promise<void>;
}

export interface Pr {
  repo: string; // the data repo, owner/name
  number: number;
  sha: string; // the head commit checked
  author: string;
}

export type SmokeCheck = (text: string, options: { path: string; now?: number }) => string[];

export type Verdict =
  | { kind: 'not-a-submission'; comment: string }
  | { kind: 'checked'; state: 'success' | 'failure'; description: string; comment: string };

const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');

/** What the pull request is and what's wrong with it, from three reads at most and no write. */
export async function checkSubmission(api: Api, pr: Pr, smokeCheck: SmokeCheck, now = Date.now()): Promise<Verdict> {
  // One page holds a submission's one file; a pull request with more than 100 isn't one either way.
  const files = (await api.get(`repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`)) as { filename: string; status: string }[];
  const file = files.length === 1 ? files[0]! : undefined;
  const match = file && ['added', 'modified'].includes(file.status) ? PATH.exec(file.filename) : null;
  if (!file || !match) {
    const what = files.map((f) => `\`${f.filename}\` (${f.status})`);
    return {
      kind: 'not-a-submission',
      comment: `This isn't a report submission, so the submission check leaves it for a person. A submission adds or replaces exactly one file, \`reports/<owner>__<repo>/<date>.json\`, as \`npx @ref0/ci-doctor --submit\` makes it. This pull request changes ${files.length === 1 ? 'one file' : `${files.length} files`}:\n\n${list(what.slice(0, 20))}${what.length > 20 ? `\n- and ${what.length - 20} more` : ''}`,
    };
  }

  const [, owner, name, date] = match;
  const repo = `${owner}/${name}`;
  const text = await api.raw(file.filename, pr.sha);
  const problems = smokeCheck(text, { path: file.filename, now });

  // submitted.by is who opened the pull request: a submission speaks for its own author. Checked when the file parsed.
  let by: unknown;
  try {
    by = JSON.parse(text)?.submitted?.by;
  } catch {}
  if (typeof by === 'string' && by.toLowerCase() !== pr.author.toLowerCase()) problems.push(`submitted.by is ${by}, but ${pr.author} opened this pull request.`);

  // The one call about the repo itself: it exists, and anyone can see it.
  const meta = await api.get(`repos/${repo}`);
  if (!meta || meta.private !== false) problems.push(`GitHub has no public repo ${repo}: a submission is of a public repo.`);
  else if (meta.full_name.toLowerCase() !== repo.toLowerCase()) problems.push(`${repo} is now ${meta.full_name}: score it under its new name and submit again.`);

  if (problems.length)
    return {
      kind: 'checked',
      state: 'failure',
      description: `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} with ${repo}'s report`,
      comment: `${repo}'s report for ${date} doesn't pass the submission check:\n\n${list(problems)}\n\nRun \`npx @ref0/ci-doctor@latest --repo ${repo} --submit\` again for a fresh report. Pushing a fixed file here runs the check again.`,
    };
  return {
    kind: 'checked',
    state: 'success',
    description: `${repo}'s report passes`,
    comment: `${repo}'s report for ${date} passes the submission check: it's JSON of the shape stored here, filed at its repo and date, made by the current scorer, with its numbers in range and a score that agrees with its own measures. ${repo} is public, and the file says ${pr.author} submitted it. Once merged, it's stored as a submitted report, not one ci-doctor-db measured: nothing here scored the repo again.`,
  };
}

/** Comments the verdict, and for a submission sets the status on the head commit. */
export async function report(api: Api, pr: Pr, v: Verdict) {
  await api.post(`repos/${pr.repo}/issues/${pr.number}/comments`, { body: v.comment });
  if (v.kind === 'checked') await api.post(`repos/${pr.repo}/statuses/${pr.sha}`, { state: v.state, context: CONTEXT, description: v.description.slice(0, 140) });
}

/** The REST API with the workflow's token. */
export const githubApi = (token: string, base = 'https://api.github.com'): Api => {
  const call = async (path: string, init: RequestInit = {}, accept = 'application/vnd.github+json') => {
    const res = await fetch(`${base}/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28', ...init.headers } });
    if (!res.ok && res.status !== 404) throw new Error(`GitHub answered ${res.status} to ${init.method ?? 'GET'} ${path}`);
    return res;
  };
  return {
    get: async (path) => {
      const res = await call(path);
      return res.status === 404 ? undefined : res.json();
    },
    raw: async (path, ref) => {
      const res = await call(`repos/${process.env.GITHUB_REPOSITORY}/contents/${path}?ref=${ref}`, {}, 'application/vnd.github.raw');
      if (res.status === 404) throw new Error(`${path} isn't at ${ref}`);
      return res.text();
    },
    post: async (path, body) => {
      const res = await call(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
      if (res.status === 404) throw new Error(`GitHub answered 404 to POST ${path}`);
    },
  };
};

if (import.meta.main) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8'));
  const pr: Pr = { repo: process.env.GITHUB_REPOSITORY!, number: event.pull_request.number, sha: event.pull_request.head.sha, author: event.pull_request.user.login };
  const { smokeCheck } = await import(pathToFileURL(process.env.SCORER!).href);
  const api = githubApi(process.env.GH_TOKEN!, process.env.GITHUB_API_URL);
  const verdict = await checkSubmission(api, pr, smokeCheck);
  await report(api, pr, verdict);
  console.log(verdict.kind === 'checked' ? `${verdict.state}: ${verdict.description}` : 'not a submission');
}
