// The submission check with a made-up API: no test reads or writes GitHub. The smoke check is the scorer's own, from
// scorer.ts, so these need a scorer with smokeCheck (CI_DOCTOR_SCORER names its scorer/src).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { shown, smokeCheck, VERSION } from '../../scorer.ts';
import { checkSubmission, report, type Api, type Pr } from '../check.ts';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const FILE = 'reports/pip__garden/2026-11-23.json';
const PR: Pr = { repo: 'ref-0/ci-doctor-db', number: 7, sha: 'c0ffee', base: 'ba5e', author: 'pip' };
const SCORER = { smokeCheck, shown };

// A report the scorer made of its made-up repo, dated for NOW and stamped with this scorer's version.
const REPORT = { ...JSON.parse(readFileSync(join(import.meta.dirname, 'pip__garden.json'), 'utf8')), date: '2026-11-23', scorerVersion: VERSION };
const text = (edit: (r: any) => void = () => {}) => {
  const r = structuredClone(REPORT);
  edit(r);
  return JSON.stringify(r, null, 1);
};
const PUBLIC = { full_name: 'pip/garden', private: false, language: 'TypeScript', owner: { login: 'pip', type: 'User' } };

// repo: null is a 404; stored: the report files already in pip__garden at the base commit.
// head: the pull request's head commit when the verdict is reported.
const fakeApi = ({ files = [{ filename: FILE, status: 'added' }] as { filename: string; status: string }[], file = text(), repo = PUBLIC as unknown, stored = [] as string[], head = 'c0ffee' } = {}) => {
  const calls: string[] = [];
  const api: Api = {
    get: async (path) => {
      calls.push(`GET ${path}`);
      if (path.endsWith('/files?per_page=100')) return files;
      if (path === 'repos/ref-0/ci-doctor-db/pulls/7') return { head: { sha: head } };
      if (path === 'repos/pip/garden') return repo ?? undefined;
      if (path === 'repos/ref-0/ci-doctor-db/contents/reports/pip__garden?ref=ba5e') return stored.length ? stored.map((name) => ({ name })) : undefined;
      return undefined;
    },
    raw: async (path, ref) => (calls.push(`RAW ${path}@${ref}`), file),
    post: async (path, body) => void calls.push(`POST ${path} ${JSON.stringify(body)}`),
  };
  return { api, calls };
};
const check = (api: Api, pr = PR) => checkSubmission(api, pr, SCORER, NOW);
const failed = (v: Awaited<ReturnType<typeof check>>) => (assert.equal(v.kind === 'checked' && v.state, 'failure', v.comment), v.comment);

describe('a submission', () => {
  it('whose head moved while it was checked gets no comment and no status: the newer push decides', async () => {
    const { api, calls } = fakeApi({ head: 'decaf' });
    const v = await check(api);

    assert.equal(await report(api, PR, v), false);
    assert.ok(!calls.some((c) => c.startsWith('POST ')));
  });

  it('whose languages are bare names fails on the language GitHub gives', async () => {
    const r = JSON.parse(text());
    r.profile.languages = ['TypeScript'];
    assert.match(failed(await check(fakeApi({ file: JSON.stringify(r) }).api)), /languages/);
  });

  it('that passes: four reads, then a comment and a success status on the head commit', async () => {
    const { api, calls } = fakeApi();
    const v = await check(api);
    assert.equal(v.kind === 'checked' && v.state, 'success', v.comment);
    assert.deepEqual(calls, [
      'GET repos/ref-0/ci-doctor-db/pulls/7/files?per_page=100',
      `RAW ${FILE}@c0ffee`,
      'GET repos/pip/garden',
      'GET repos/ref-0/ci-doctor-db/contents/reports/pip__garden?ref=ba5e',
    ]);
    assert.match(v.comment, /For whoever merges: this is `pip\/garden`'s first report here, and `pip` owns it\.$/);

    assert.equal(await report(api, PR, v), true);
    assert.equal(calls[4], 'GET repos/ref-0/ci-doctor-db/pulls/7');
    assert.match(calls[5]!, /^POST repos\/ref-0\/ci-doctor-db\/issues\/7\/comments .*passes the submission check/);
    assert.equal(calls[6], `POST repos/ref-0/ci-doctor-db/statuses/c0ffee ${JSON.stringify({ state: 'success', context: 'submission', description: "pip/garden's report passes" })}`);
  });

  it("says, without failing, what's stored here already and whose repo it is", async () => {
    const theirs = await check(fakeApi({ repo: { ...PUBLIC, owner: { login: 'garden-club', type: 'Organization' } }, stored: ['2026-11-19.json', '2026-11-20.json'] }).api);
    assert.equal(theirs.kind === 'checked' && theirs.state, 'success');
    assert.match(theirs.comment, /For whoever merges: `pip\/garden` has 2 reports here already, and it belongs to the organization `garden-club`, not to `pip`\.$/);
    const mos = await check(fakeApi({ repo: { ...PUBLIC, owner: { login: 'mo', type: 'User' } } }).api);
    assert.match(mos.comment, /and it belongs to `mo`, not to `pip`\.$/);
  });

  it('with an edited score fails, saying why, with the facts still there', async () => {
    const comment = failed(await check(fakeApi({ file: text((r) => (r.score = 97)) }).api));
    assert.match(comment, /doesn't pass the submission check:\n\n- score is 97, but its own measures give \d+\./);
    assert.match(comment, /npx @ref0\/ci-doctor@latest --repo pip\/garden --submit/);
    assert.match(comment, /For whoever merges: this is `pip\/garden`'s first report here, and `pip` owns it\.$/);
  });

  it('of a private or missing repo fails', async () => {
    for (const repo of [{ ...PUBLIC, private: true }, null]) assert.match(failed(await check(fakeApi({ repo }).api)), /GitHub has no public repo `pip\/garden`/);
  });

  it('under a name GitHub spells another way fails, so one repo never has two folders', async () => {
    assert.match(failed(await check(fakeApi({ repo: { ...PUBLIC, full_name: 'Pip/Garden' } }).api)), /GitHub spells the repo `Pip\/Garden`, not `pip\/garden`/);
  });

  it("whose GitHub language the report doesn't list fails", async () => {
    assert.match(failed(await check(fakeApi({ repo: { ...PUBLIC, language: 'Rust' } }).api)), /GitHub says `pip\/garden` is mostly `Rust`, which the report's languages don't list\./);
    const v = await check(fakeApi({ repo: { ...PUBLIC, language: null } }).api);
    assert.equal(v.kind === 'checked' && v.state, 'success', 'a repo GitHub names no language for passes');
  });

  it('that someone else submitted in another name fails', async () => {
    assert.match(failed(await check(fakeApi().api, { ...PR, author: 'mo' })), /submitted\.by is `pip`, but `mo` opened this pull request\./);
  });

  it('that is no JSON fails, and still asks after the repo', async () => {
    const { api, calls } = fakeApi({ file: 'not json' });
    assert.match(failed(await check(api)), /- The file isn't JSON\./);
    assert.ok(calls.includes('GET repos/pip/garden'));
  });
});

describe('not a submission', () => {
  for (const [what, files] of [
    ['two files', [{ filename: FILE, status: 'added' }, { filename: 'loop/measure.ts', status: 'modified' }]],
    ['a file outside a report folder', [{ filename: 'reports/notes.json', status: 'added' }]],
    ['a replaced report', [{ filename: FILE, status: 'modified' }]],
    ['a removed report', [{ filename: FILE, status: 'removed' }]],
    ['a renamed report', [{ filename: FILE, status: 'renamed' }]],
  ] as const)
    it(`${what}: a comment, no status, and nothing read but the files and the head`, async () => {
      const { api, calls } = fakeApi({ files: [...files] });
      const v = await check(api);
      assert.equal(v.kind, 'not-a-submission');
      assert.match(v.comment, /leaves it for a person/);
      await report(api, PR, v);
      assert.deepEqual(calls.slice(0, 2), ['GET repos/ref-0/ci-doctor-db/pulls/7/files?per_page=100', 'GET repos/ref-0/ci-doctor-db/pulls/7']);
      assert.equal(calls.length, 3);
      assert.match(calls[2]!, /^POST repos\/ref-0\/ci-doctor-db\/issues\/7\/comments /);
    });

  it("prints a file's name only in a safe form", async () => {
    const v = await check(fakeApi({ files: [{ filename: 'reports/x/`](https://evil.example)\n<b>.json', status: 'added' }] }).api);
    assert.doesNotMatch(v.comment, /\]\(|<b>|evil.example\n/);
    assert.match(v.comment, /`reports\/x\/https:\/\/evil.exampleb.json` \(`added`\)/);
  });
});
