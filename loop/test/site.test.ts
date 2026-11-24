import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { open } from '../db.ts';
import { importReports } from '../import.ts';
import { changed, literal, NOT_ON_SITE, siteSql, STATEMENT_BYTES } from '../site.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');

const dump = (db: ReturnType<typeof open>) =>
  ['repos', 'reports', 'checks'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).all());

const shas = (db: ReturnType<typeof open>) =>
  new Map(db.prepare('SELECT id, sha256 FROM reports').all().map((r) => [String(r.id), String(r.sha256)]));

/** loop.db from the fixtures, and the site's D1 as the schema leaves it, empty. */
function both() {
  const loop = open(':memory:');
  importReports(loop, FIXTURES);
  return { loop, site: open(':memory:') };
}

/** What a push runs on D1: the reports D1 lacks or holds at another sha256, every repo and the checks it lacks. */
const push = ({ loop, site }: ReturnType<typeof both>) => {
  const send = changed(loop.prepare('SELECT * FROM reports').all(), shas(site));
  site.exec(siteSql(send, loop.prepare('SELECT * FROM repos').all(), loop.prepare('SELECT * FROM checks').all()));
  return send.length;
};

test('a literal quotes text with its quotes doubled and writes nothing as NULL', () => {
  assert.equal(literal("it's"), "'it''s'");
  assert.equal(literal(null), 'NULL');
  assert.equal(literal(0.25), '0.25');
});

test("a push names no column the site's D1 lacks", () => {
  const { loop } = both();
  const sql = siteSql(loop.prepare('SELECT * FROM reports').all(), [], []);

  assert.ok(sql.length > 0);
  for (const column of NOT_ON_SITE) assert.ok(!sql.includes(column), column);
});

test('a push leaves D1 holding what loop.db does, and a second one sends nothing', () => {
  const dbs = both();

  assert.equal(push(dbs), 6);
  assert.deepEqual(dump(dbs.site), dump(dbs.loop));
  assert.equal(push(dbs), 0);
  assert.deepEqual(dump(dbs.site), dump(dbs.loop));
});

test("a report longer than D1's statement limit goes in pieces, and D1 holds it whole", () => {
  const dbs = both();
  const stack = JSON.stringify({ libraries: Array.from({ length: 9_000 }, (_, i) => ({ name: `it's-\u{1F9EA}-${i}`, packages: i })) });
  assert.ok(Buffer.byteLength(stack) > 2 * STATEMENT_BYTES);
  dbs.loop.prepare("UPDATE reports SET stack = ?, sha256 = 'long' WHERE id = 'vitejs/vite/2026-11-19_rescored'").run(stack);

  const send = changed(dbs.loop.prepare('SELECT * FROM reports').all(), shas(dbs.site));
  const sql = siteSql(send, dbs.loop.prepare('SELECT * FROM repos').all(), dbs.loop.prepare('SELECT * FROM checks').all());
  for (const statement of sql.split('\n')) assert.ok(Buffer.byteLength(statement) <= STATEMENT_BYTES, statement.slice(0, 80));

  dbs.site.exec(sql);
  assert.deepEqual(dump(dbs.site), dump(dbs.loop));

  dbs.loop.exec("UPDATE reports SET stack = '{}', sha256 = 'short' WHERE id = 'vitejs/vite/2026-11-19_rescored'");
  assert.equal(push(dbs), 1);
  assert.deepEqual(dump(dbs.site), dump(dbs.loop));
});

test("a report changed since the last push is changed in place, though a repo's latest and a check point at it", () => {
  const dbs = both();
  push(dbs);
  dbs.loop.exec("UPDATE reports SET score = 99, sha256 = 'new' WHERE id = 'vitejs/vite/2026-11-19_rescored'");

  assert.equal(push(dbs), 1);
  assert.deepEqual(dump(dbs.site), dump(dbs.loop));
});
