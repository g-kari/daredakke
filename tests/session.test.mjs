import test from 'node:test';
import assert from 'node:assert/strict';
import { readNamespace, identityChanged, readSessionFile } from '../src/lib/session.ts';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../src/worker/index.ts';
import { ownerNamespace } from '../src/worker/auth.ts';
test('client accepts only opaque server namespaces and distinguishes identity change from revision conflict', () => {
  const namespace = 'u_' + 'a'.repeat(64);
  assert.equal(readNamespace({ namespace }), namespace);
  for (const value of [null, {}, { namespace: 'owner' }, { namespace: namespace + 'a' }, { namespace: namespace.toUpperCase() }, { namespace: 1 }]) assert.throws(() => readNamespace(value));
  assert.equal(identityChanged(409, { code: 'identity_changed' }), true);
  assert.equal(identityChanged(401, {}), true);
  assert.equal(identityChanged(403, null), true);
  assert.equal(identityChanged(409, { error: 'revision conflict' }), false);
  assert.equal(identityChanged(200, { code: 'identity_changed' }), false);
});
test('session route verifies owner JWT, returns only current namespace and never touches D1 or assets', async () => {
  const cfg = { APP_ORIGIN: 'https://daredakke.example.com', ACCESS_TEAM_DOMAIN: 'https://synthetic-session-route.cloudflareaccess.com', ACCESS_AUDIENCE: 'synthetic-session-audience', OWNER_EMAIL: 'owner@example.com' };
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'ephemeral-session-key', alg: 'RS256' };
  const now = Math.floor(Date.now() / 1000);
  const token = email => new SignJWT({ iss: cfg.ACCESS_TEAM_DOMAIN, aud: [cfg.ACCESS_AUDIENCE], sub: 'synthetic-owner', email, type: 'app', iat: now, nbf: now - 1, exp: now + 60 }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).sign(privateKey);
  let touched = 0;
  const env = { ...cfg, DB: { prepare() { touched++; throw new Error('unexpected D1 access'); } }, ASSETS: { fetch() { touched++; throw new Error('unexpected asset access'); } } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => { assert.equal(url, cfg.ACCESS_TEAM_DOMAIN + '/cdn-cgi/access/certs'); return Response.json({ keys: [jwk] }); };
  try {
    const url = cfg.APP_ORIGIN + '/api/session?owner_id=forged';
    assert.equal((await worker.fetch(new Request(url), env)).status, 401);
    const ownerToken = await token(cfg.OWNER_EMAIL);
    const result = await worker.fetch(new Request(url, { headers: { 'Cf-Access-Jwt-Assertion': ownerToken } }), env);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await result.json(), { namespace: await ownerNamespace(cfg.ACCESS_TEAM_DOMAIN, 'synthetic-owner') });
    assert.equal((await worker.fetch(new Request(url, { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': ownerToken } }), env)).status, 405);
    assert.equal((await worker.fetch(new Request(url, { headers: { 'Cf-Access-Jwt-Assertion': await token('other@example.com') } }), env)).status, 401);
    assert.equal(touched, 0);
  } finally { globalThis.fetch = originalFetch; }
});
test('deferred file content cannot reappear after identity clear, namespace change or scope reload', async () => {
  for (const transition of ['clear', 'identity', 'scope']) {
    let namespace = 'A', epoch = 1, finish;
    const file = { text: () => new Promise(resolve => { finish = resolve; }) };
    const read = readSessionFile(file, () => namespace === 'A' && epoch === 1);
    if (transition === 'clear') namespace = null;
    if (transition === 'identity') namespace = 'B';
    if (transition === 'scope') epoch++;
    finish('synthetic A import content');
    assert.equal(await read, null, transition);
  }
  let touched = false;
  assert.equal(await readSessionFile({ text: async () => { touched = true; return 'unused'; } }, () => false), null);
  assert.equal(touched, false, 'already stale operation does not read the file');
});
test('newer file selection supersedes an older pending read within the same session', async () => {
  let generation = 1, finish;
  const older = readSessionFile({ text: () => new Promise(resolve => { finish = resolve; }) }, () => generation === 1);
  generation++;
  assert.equal(await readSessionFile({ text: async () => 'newer synthetic import' }, () => generation === 2), 'newer synthetic import');
  finish('older synthetic import');
  assert.equal(await older, null);
});
