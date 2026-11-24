// The check on a pull request that submits a report, from `npx @ref0/ci-doctor --submit`. The workflow
// (.github/workflows/submission.yml) runs this file from the default branch, never from the pull request, and treats
// the pull request as data: it reads the changed files and the one added file's content through the API, runs the
// scorer package's smokeCheck on it, asks GitHub once about the repo (public, its exact name, its main language), and
// reads this repo's folder for it at the base commit. It doesn't score the repo again. It comments what it found, with
// what a merger should know, and sets the `submission` status on the head commit: success is what a merger can rely
// on. A pull request that changes anything else, or replaces a file, isn't a submission, gets no status, and is left
// for a person. Every value from the file or GitHub is printed through the scorer's `shown`.
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
  base: string; // the base commit, where what's stored already is read
  author: string;
}

/** What the check takes from the scorer package: its smokeCheck, and how a value from a file is printed safely. */
export interface Scorer {
  smokeCheck: (text: string, options: { path: string; now?: number }) => string[];
  shown: (x: unknown) => string;
}

export type Verdict =
  | { kind: 'not-a-submission'; comment: string }
  | { kind: 'checked'; state: 'success' | 'failure'; description: string; comment: string };

const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');

/** What the pull request is, what's wrong with it, and what a merger should know, from four reads at most and no write. */
export async function checkSubmission(api: Api, pr: Pr, { smokeCheck, shown }: Scorer, now = Date.now()): Promise<Verdict> {
  // One page holds a submission's one file; a pull request with more than 100 isn't one either way.
  const files = (await api.get(`repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`)) as { filename: string; status: string }[];
  const file = files.length === 1 ? files[0]! : undefined;
  // Only an added file: a submission never replaces a report that's here, measured or submitted.
  const match = file?.status === 'added' ? PATH.exec(file.filename) : null;
  if (!file || !match) {
    const what = files.map((f) => `${shown(f.filename)} (${shown(f.status)})`);
    return {
      kind: 'not-a-submission',
      comment: `This isn't a report submission, so the submission check leaves it for a person. A submission adds exactly one new file, \`reports/<owner>__<repo>/<date>.json\`, as \`npx @ref0/ci-doctor --submit\` makes it, and never replaces one that's here. This pull request changes ${files.length === 1 ? 'one file' : `${files.length} files`}:\n\n${list(what.slice(0, 20))}${what.length > 20 ? `\n- and ${what.length - 20} more` : ''}`,
    };
  }

  const [, owner, name, date] = match;
  const repo = `${owner}/${name}`;
  const dir = file.filename.slice(0, file.filename.lastIndexOf('/'));
  const text = await api.raw(file.filename, pr.sha);
  const problems = smokeCheck(text, { path: file.filename, now });
  let report: any;
  try {
    report = JSON.parse(text);
  } catch {}

  // submitted.by is who opened the pull request: a submission speaks for its own author.
  const by = report?.submitted?.by;
  if (typeof by === 'string' && by.toLowerCase() !== pr.author.toLowerCase()) problems.push(`submitted.by is ${shown(by)}, but ${shown(pr.author)} opened this pull request.`);

  // The one call about the repo itself: it exists, anyone can see it, it has this name exactly, and its main language is one the report saw.
  const meta = await api.get(`repos/${repo}`);
  if (!meta || meta.private !== false) problems.push(`GitHub has no public repo ${shown(repo)}: a submission is of a public repo.`);
  else {
    if (meta.full_name !== repo) problems.push(`GitHub spells the repo ${shown(meta.full_name)}, not ${shown(repo)}: run \`npx @ref0/ci-doctor@latest --repo ${meta.full_name} --submit\` again, which files it under GitHub's name.`);
    const languages = Array.isArray(report?.profile?.languages) ? report.profile.languages.map((l: unknown) => (Array.isArray(l) ? l[0] : l)) : [];
    if (typeof meta.language === 'string' && report && !languages.includes(meta.language)) problems.push(`GitHub says ${shown(repo)} is mostly ${shown(meta.language)}, which the report's languages don't list.`);
  }

  // For the person merging: what's here for this repo already, at the base commit, and whose repo it is. Neither fails the check.
  const here = await api.get(`repos/${pr.repo}/contents/${dir}?ref=${pr.base}`);
  const stored = Array.isArray(here) ? here.filter((f: { name?: string }) => f.name?.endsWith('.json')).length : 0;
  const whose = !meta?.owner
    ? "who owns it isn't known"
    : meta.owner.login.toLowerCase() === pr.author.toLowerCase()
      ? `${shown(pr.author)} owns it`
      : meta.owner.type === 'Organization'
        ? `it belongs to the organization ${shown(meta.owner.login)}, not to ${shown(pr.author)}`
        : `it belongs to ${shown(meta.owner.login)}, not to ${shown(pr.author)}`;
  const facts = `For whoever merges: ${stored ? `${shown(repo)} has ${stored} ${stored === 1 ? 'report' : 'reports'} here already` : `this is ${shown(repo)}'s first report here`}, and ${whose}.`;

  if (problems.length)
    return {
      kind: 'checked',
      state: 'failure',
      description: `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} with ${repo}'s report`,
      comment: `${shown(repo)}'s report for ${date} doesn't pass the submission check:\n\n${list(problems)}\n\nRun \`npx @ref0/ci-doctor@latest --repo ${repo} --submit\` again for a fresh report. Pushing a fixed file here runs the check again.\n\n${facts}`,
    };
  return {
    kind: 'checked',
    state: 'success',
    description: `${repo}'s report passes`,
    comment: `${shown(repo)}'s report for ${date} passes the submission check: it's JSON of the shape stored here with only safe strings, filed at its repo and date, made by the current scorer, with its numbers in range and in order, and a score that agrees with its own measures. ${shown(repo)} is public under that name, its main language is in the report, and the file says ${shown(pr.author)} submitted it. Once merged, it's stored as a submitted report: nothing here scored the repo, and the nightly doesn't measure a repo that only has submitted reports.\n\n${facts}`,
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
  const pr: Pr = { repo: process.env.GITHUB_REPOSITORY!, number: event.pull_request.number, sha: event.pull_request.head.sha, base: event.pull_request.base.sha, author: event.pull_request.user.login };
  const scorer: Scorer = await import(pathToFileURL(process.env.SCORER!).href);
  const api = githubApi(process.env.GH_TOKEN!, process.env.GITHUB_API_URL);
  const verdict = await checkSubmission(api, pr, scorer);
  await report(api, pr, verdict);
  console.log(verdict.kind === 'checked' ? `${verdict.state}: ${verdict.description}` : 'not a submission');
}
