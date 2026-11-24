// The submission check with a made-up API: no test reads or writes GitHub. The smoke check is the scorer's own, from
// scorer.ts, so these need a scorer with smokeCheck (CI_DOCTOR_SCORER names its scorer/src).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { smokeCheck, VERSION } from '../../scorer.ts';
import { checkSubmission, report, type Api, type Pr } from '../check.ts';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const FILE = 'reports/pip__garden/2026-11-23.json';
const PR: Pr = { repo: 'ref-0/ci-doctor-db', number: 7, sha: 'c0ffee', author: 'pip' };

// A report the scorer made of its made-up repo, dated for NOW and stamped with this scorer's version.
const REPORT = { ...JSON.parse(readFileSync(join(import.meta.dirname, 'pip__garden.json'), 'utf8')), date: '2026-11-23', scorerVersion: VERSION };
const text = (edit: (r: any) => void = () => {}) => {
  const r = structuredClone(REPORT);
  edit(r);
  return JSON.stringify(r, null, 1);
};

const fakeApi = ({ files = [{ filename: FILE, status: 'added' }] as { filename: string; status: string }[], file = text(), repo = { full_name: 'pip/garden', private: false } as unknown } = {}) => {
  // repo: null is a 404.
  const calls: string[] = [];
  const api: Api = {
    get: async (path) => (calls.push(`GET ${path}`), path.endsWith('/files?per_page=100') ? files : path === 'repos/pip/garden' ? (repo ?? undefined) : undefined),
    raw: async (path, ref) => (calls.push(`RAW ${path}@${ref}`), file),
    post: async (path, body) => void calls.push(`POST ${path} ${JSON.stringify(body)}`),
  };
  return { api, calls };
};
const check = (api: Api, pr = PR) => checkSubmission(api, pr, smokeCheck, NOW);

describe('a submission', () => {
  it('that passes: three reads, then a comment and a success status on the head commit', async () => {
    const { api, calls } = fakeApi();
    const v = await check(api);
    assert.equal(v.kind === 'checked' && v.state, 'success', v.comment);
    assert.deepEqual(calls, [`GET repos/ref-0/ci-doctor-db/pulls/7/files?per_page=100`, `RAW ${FILE}@c0ffee`, 'GET repos/pip/garden']);

    await report(api, PR, v);
    assert.match(calls[3]!, /^POST repos\/ref-0\/ci-doctor-db\/issues\/7\/comments .*passes the submission check/);
    assert.equal(calls[4], `POST repos/ref-0/ci-doctor-db/statuses/c0ffee ${JSON.stringify({ state: 'success', context: 'submission', description: "pip/garden's report passes" })}`);
  });

  it('that replaces a stored report is one too', async () => {
    const { api } = fakeApi({ files: [{ filename: FILE, status: 'modified' }] });
    assert.equal((await check(api)).kind, 'checked');
  });

  it('with an edited score fails, saying why', async () => {
    const { api } = fakeApi({ file: text((r) => (r.score = 97)) });
    const v = await check(api);
    assert.equal(v.kind === 'checked' && v.state, 'failure');
    assert.match(v.comment, /doesn't pass the submission check:\n\n- score is 97, but its own measures give \d+\./);
    assert.match(v.comment, /npx @ref0\/ci-doctor@latest --repo pip\/garden --submit/);
  });

  it('of a private or missing repo fails', async () => {
    for (const repo of [{ full_name: 'pip/garden', private: true }, null]) {
      const v = await check(fakeApi({ repo }).api);
      assert.match(v.comment, /GitHub has no public repo pip\/garden/);
    }
  });

  it('that someone else submitted in another name fails', async () => {
    const v = await check(fakeApi().api, { ...PR, author: 'mo' });
    assert.match(v.comment, /submitted\.by is pip, but mo opened this pull request\./);
  });

  it('that is no JSON fails, and still asks after the repo', async () => {
    const { api, calls } = fakeApi({ file: 'not json' });
    const v = await check(api);
    assert.match(v.comment, /- The file isn't JSON\./);
    assert.equal(calls.at(-1), 'GET repos/pip/garden');
  });
});

describe('not a submission', () => {
  for (const [what, files] of [
    ['two files', [{ filename: FILE, status: 'added' }, { filename: 'loop/measure.ts', status: 'modified' }]],
    ['a file outside a report folder', [{ filename: 'reports/notes.json', status: 'added' }]],
    ['a removed report', [{ filename: FILE, status: 'removed' }]],
    ['a renamed report', [{ filename: FILE, status: 'renamed' }]],
  ] as const)
    it(`${what}: a comment, no status, and nothing read but the files`, async () => {
      const { api, calls } = fakeApi({ files: [...files] });
      const v = await check(api);
      assert.equal(v.kind, 'not-a-submission');
      assert.match(v.comment, /leaves it for a person/);
      await report(api, PR, v);
      assert.equal(calls.length, 2);
      assert.match(calls[1]!, /^POST repos\/ref-0\/ci-doctor-db\/issues\/7\/comments /);
    });
});
