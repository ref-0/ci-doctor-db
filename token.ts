// Prints an installation token for the ref0-ci-doctor GitHub App, cached until 10 minutes before it
// expires. The key stays in ~/.config/ci-score/app.pem; this never prints it.
// Usage: GH_TOKEN=$(node token.ts) gh api ...
import { createSign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.config', 'ci-score');
const CLIENT_ID = 'Iv23liqxyiffTIkCrcvC';
const CACHE = join(DIR, 'token.json');

if (existsSync(CACHE)) {
  const c = JSON.parse(readFileSync(CACHE, 'utf8'));
  if (Date.parse(c.expires_at) - Date.now() > 10 * 60e3) {
    process.stdout.write(c.token);
    process.exit(0);
  }
}

const b64 = (x: string | Buffer) => Buffer.from(x).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify({ iat: now - 60, exp: now + 540, iss: CLIENT_ID }))}`;
const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(readFileSync(join(DIR, 'app.pem')), 'base64url')}`;
const gh = (path: string, method = 'GET') =>
  fetch(`https://api.github.com/${path}`, {
    method,
    headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'user-agent': 'ci-score' },
  }).then(async (r) => {
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    return r.json() as Promise<any>;
  });

const [install] = await gh('app/installations');
if (!install) throw new Error('The App has no installation');
const token = await gh(`app/installations/${install.id}/access_tokens`, 'POST');
writeFileSync(CACHE, JSON.stringify({ token: token.token, expires_at: token.expires_at, installation: install.id }), { mode: 0o600 });
process.stdout.write(token.token);
