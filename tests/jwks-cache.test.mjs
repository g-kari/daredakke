import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authenticateOwner, ownerNamespace } from '../src/worker/auth.ts';
import { createAccessResolverCache } from '../src/worker/jwks-cache.ts';

async function ephemeralKey(kid) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid, alg: 'RS256', use: 'sig' };
  return { jwk, privateKey };
}
function configFor(team) {
  return {
    origin: 'https://daredakke.example.com', issuer: `https://${team}.cloudflareaccess.com`,
    audience: 'synthetic-cache-audience', ownerEmail: 'owner@example.com',
  };
}
async function ownerToken(config, key, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: config.issuer, aud: [config.audience], sub: 'synthetic-owner',
    email: config.ownerEmail, type: 'app', iat: now, nbf: now - 1, exp: now + 3600,
    ...overrides,
  }).setProtectedHeader({ alg: 'RS256', kid: key.jwk.kid }).sign(key.privateKey);
}
function requestFor(token) {
  return new Request('https://daredakke.example.com/api/records', {
    headers: { 'Cf-Access-Jwt-Assertion': token },
  });
}

test('same-isolate authentication reuses fresh public keys through outage, rotates and fails closed when stale', async () => {
  const config = configFor('synthetic-cache-reuse');
  const oldKey = await ephemeralKey('old-key');
  const newKey = await ephemeralKey('rotated-key');
  const oldToken = await ownerToken(config, oldKey);
  const newToken = await ownerToken(config, newKey);
  const wrongOwnerToken = await ownerToken(config, oldKey, { email: 'other@example.com' });
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let clock = originalNow(), fetches = 0, outage = false;
  let publicKeys = [oldKey.jwk];
  Date.now = () => clock;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, config.issuer + '/cdn-cgi/access/certs');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    fetches++;
    if (outage) throw new Error('synthetic cert endpoint outage');
    return Response.json({ keys: publicKeys });
  };
  try {
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await authenticateOwner(requestFor(oldToken), config), { ownerId: await ownerNamespace(config.issuer, 'synthetic-owner'), subject: 'synthetic-owner' });
    }
    assert.equal(fetches, 1, 'one resolver keeps its public-key cache across requests');
    outage = true;
    assert.ok(await authenticateOwner(requestFor(oldToken), config), 'fresh cached key remains usable during an outage');
    assert.equal(await authenticateOwner(requestFor(wrongOwnerToken), config), null, 'cached keys never cache an owner decision');
    assert.equal(await authenticateOwner(requestFor(newToken), config), null, 'unknown key fails closed during the cooldown');
    assert.equal(fetches, 1, 'unknown keys cannot force refresh during the 30-second cooldown');
    outage = false;
    publicKeys = [oldKey.jwk, newKey.jwk];
    clock += 30001;
    assert.ok(await authenticateOwner(requestFor(newToken), config), 'new key refreshes after the cooldown');
    assert.ok(await authenticateOwner(requestFor(oldToken), config), 'published old key is still usable after rotation');
    assert.equal(fetches, 2);
    clock += 600001;
    outage = true;
    assert.equal(await authenticateOwner(requestFor(oldToken), config), null, 'expired cache never bypasses an unavailable cert endpoint');
    assert.equal(fetches, 3, '10-minute freshness remains finite');
    outage = false;
    publicKeys = [newKey.jwk];
    assert.ok(await authenticateOwner(requestFor(newToken), config), 'recovery refreshes keys after a failed fetch');
    assert.equal(await authenticateOwner(requestFor(oldToken), config), null, 'removed keys fail closed after refresh');
    assert.equal(fetches, 4);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test('issuer-specific public-key caches do not authenticate tokens from another issuer', async () => {
  const first = configFor('synthetic-cache-first'), second = configFor('synthetic-cache-second');
  const firstKey = await ephemeralKey('shared-kid'), secondKey = await ephemeralKey('shared-kid');
  const firstToken = await ownerToken(first, firstKey), secondToken = await ownerToken(second, secondKey);
  const forgedFirstToken = await ownerToken(first, secondKey);
  const originalFetch = globalThis.fetch;
  const fetches = new Map();
  globalThis.fetch = async (url) => {
    assert.ok([first.issuer + '/cdn-cgi/access/certs', second.issuer + '/cdn-cgi/access/certs'].includes(url));
    fetches.set(url, (fetches.get(url) ?? 0) + 1);
    return Response.json({ keys: [url.startsWith(first.issuer + '/') ? firstKey.jwk : secondKey.jwk] });
  };
  try {
    assert.ok(await authenticateOwner(requestFor(firstToken), first));
    assert.ok(await authenticateOwner(requestFor(secondToken), second));
    assert.ok(await authenticateOwner(requestFor(firstToken), first));
    assert.equal(await authenticateOwner(requestFor(secondToken), first), null);
    assert.equal(await authenticateOwner(requestFor(forgedFirstToken), first), null, 'matching kid cannot cross issuer key boundaries');
    assert.deepEqual([...fetches.values()], [1, 1]);
  } finally { globalThis.fetch = originalFetch; }
});

test('resolver cache normalizes validated issuer, rejects untrusted endpoints and evicts least-recently-used entries', () => {
  const created = [];
  const resolve = createAccessResolverCache(issuer => {
    created.push(issuer);
    return async () => { throw new Error('unused synthetic resolver'); };
  }, 2);
  const a = 'https://cache-a.cloudflareaccess.com';
  const b = 'https://cache-b.cloudflareaccess.com';
  const c = 'https://cache-c.cloudflareaccess.com';
  const firstA = resolve(a), firstB = resolve(b);
  assert.equal(resolve(a + '/'), firstA);
  resolve(c);
  assert.equal(resolve(a), firstA, 'recently used entry is retained');
  assert.notEqual(resolve(b), firstB, 'least-recently-used entry was evicted');
  assert.deepEqual(created, [a, b, c, b]);
  for (const issuer of ['http://cache-a.cloudflareaccess.com', 'https://evil.example', a + '.evil.example', a + '/path', a + '?url=https://evil.example', 'https://user:pass@cache-a.cloudflareaccess.com', null]) {
    assert.throws(() => resolve(issuer), /invalid_access_issuer/);
  }
  assert.equal(created.length, 4, 'invalid issuers never reach the resolver factory');
  for (const limit of [0, 5, 1.5, Infinity]) assert.throws(() => createAccessResolverCache(() => firstA, limit), /invalid_cache_limit/);
});
