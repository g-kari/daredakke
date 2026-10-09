import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { serveBundledAsset } from '../src/worker/bundled-assets.ts';
import worker from '../src/worker/index.ts';

const origin = 'https://daredakke.example.com';
const fixtureEntries = {
  '/index.html': {
    body: '<!doctype html>\n<html lang="ja"><head><title>synthetic bundle</title></head><body>合成テスト &amp; "quotes"<script type="module" src="/assets/app-1a2b3c4d.js"></script></body></html>\n',
    contentType: 'text/html; charset=utf-8',
  },
  '/favicon.svg': {
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><path d="M0 0h4v4H0z"/></svg>\n',
    contentType: 'image/svg+xml; charset=utf-8',
  },
  '/assets/app-1a2b3c4d.js': {
    body: 'const synthetic = "</script><script>synthetic-only</script>";\nconsole.log("合成", synthetic);\n',
    contentType: 'text/javascript; charset=utf-8',
  },
  '/assets/app-5e6f7081.css': {
    body: ':root { --synthetic: "合成"; }\nbody::after { content: "<script> & quotes"; }\n',
    contentType: 'text/css; charset=utf-8',
  },
};
const fixtureFiles = () => Object.assign(Object.create(null), fixtureEntries);
const request = (path, options = {}) => new Request(origin + path, options);

function assertPrivateHeaders(response) {
  const cache = response.headers.get('cache-control')?.toLowerCase().split(',').map(value => value.trim());
  assert.ok(cache?.includes('private'), 'the response is private');
  assert.ok(cache?.includes('no-store'), 'the response is never stored');
  assert.ok(!cache.includes('public'), 'the response never allows public caching');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
}

async function assertAssetResponse(path, key, method = 'GET', files = fixtureFiles()) {
  const response = await serveBundledAsset(request(path, { method }), files);
  assert.equal(response.status, 200, path);
  assertPrivateHeaders(response);
  assert.equal(response.headers.get('content-type'), fixtureEntries[key].contentType, path);
  if (response.headers.has('content-length')) assert.equal(Number(response.headers.get('content-length')), new TextEncoder().encode(fixtureEntries[key].body).byteLength, 'declared byte length is correct for both GET and HEAD');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new TextEncoder().encode(method === 'HEAD' ? '' : fixtureEntries[key].body), path);
  return response;
}

test('bundled HTML, SVG, JavaScript and CSS preserve exact UTF-8 bytes and their safe MIME types', async () => {
  for (const path of Object.keys(fixtureEntries)) await assertAssetResponse(path, path);
});

test('root and extensionless SPA paths use index.html without reflecting path, query or fragment data', async () => {
  for (const path of ['/', '/friends', '/friends/synthetic-id', '/friends/', '/?next=%3Cscript%3Esynthetic%3C/script%3E#synthetic-fragment']) {
    await assertAssetResponse(path, '/index.html');
  }
});

test('asset queries and fragments do not change lookup, MIME or response bytes', async () => {
  for (const path of Object.keys(fixtureEntries)) await assertAssetResponse(path + '?contentType=text/html&body=%3Csvg%20onload%3Dsynthetic%3E#ignored', path);
});

test('unknown assets and filelike paths return private 404s instead of SPA HTML or attacker-controlled bytes', async () => {
  for (const path of ['/assets/missing.js', '/assets/missing', '/assets/app-1a2b3c4d.js/', '/assets//app-1a2b3c4d.js', '/assets/APP-1a2b3c4d.js', '/missing.html', '/.env', '/package.json', '/index.htm', '/INDEX.html', '/Favicon.svg', '/favicon.svg/extra', '/%3Cscript%3Esynthetic-xss-marker%3C/script%3E.js']) {
    const response = await serveBundledAsset(request(path), fixtureFiles());
    assert.equal(response.status, 404, path);
    assertPrivateHeaders(response);
    const body = await response.text();
    assert.notEqual(body, fixtureEntries['/index.html'].body, path);
    assert.ok(!body.includes('synthetic-xss-marker'), 'missing-path errors never reflect request data');
    assert.ok(!body.includes(path), 'missing-path errors never expose the requested path');
  }
});

test('lookup never decodes percent-encoded names, separators or traversal-like paths into bundled files', async () => {
  // Request/URL already normalize bare dot segments. These encoded separators are
  // preserved in pathname, so the adapter must not decode or normalize them again.
  for (const path of ['/assets/%61pp-1a2b3c4d.js', '/assets/app-1a2b3c4d%2Ejs', '/assets/%2e%2e%2findex.html', '/assets/%2E%2E%2Findex.html', '/assets/..%2findex.html', '/assets/%252e%252e%252findex.html', '/assets/%5c..%5cindex.html', '/assets/%2fapp-1a2b3c4d.js', '/assets/app-1a2b3c4d.js%00', '/%3Csvg%20onload%3Dsynthetic%3E', '/friends%2fsynthetic-id']) {
    assert.equal(new URL(request(path).url).pathname, path, 'the encoded test path reaches the adapter intact');
    const response = await serveBundledAsset(request(path), fixtureFiles());
    assert.equal(response.status, 404, path);
    assertPrivateHeaders(response);
    const body = await response.text();
    assert.notEqual(body, fixtureEntries['/index.html'].body, path);
    assert.notEqual(body, fixtureEntries['/assets/app-1a2b3c4d.js'].body, path);
  }
});

test('only own properties can become files, including index fallback and prototype-shaped names', async () => {
  const inherited = {
    '/favicon.svg': { body: 'synthetic inherited SVG must stay hidden', contentType: 'text/html' },
    '/ghost.html': { body: 'synthetic inherited HTML must stay hidden', contentType: 'text/html' },
    '/ghost': { body: 'synthetic inherited route must stay hidden', contentType: 'text/html' },
    '/assets/__proto__': { body: 'synthetic inherited prototype must stay hidden', contentType: 'text/html' },
  };
  const files = Object.assign(Object.create(inherited), fixtureEntries);
  delete files['/favicon.svg'];
  files.hasOwnProperty = () => true;
  for (const path of ['/favicon.svg', '/ghost.html', '/__proto__', '/constructor', '/prototype', '/assets/__proto__', '/assets/constructor', '/assets/toString', '/friends/prototype/view']) {
    const response = await serveBundledAsset(request(path), files);
    assert.equal(response.status, 404, path);
    assertPrivateHeaders(response);
    assert.ok(!(await response.text()).includes('must stay hidden'), path);
  }
  await assertAssetResponse('/ghost', '/index.html', 'GET', files);
  const inheritedIndex = Object.create({ '/index.html': fixtureEntries['/index.html'] });
  for (const path of ['/', '/index.html', '/friends']) {
    const response = await serveBundledAsset(request(path), inheritedIndex);
    assert.equal(response.status, 404, path);
    assertPrivateHeaders(response);
    assert.notEqual(await response.text(), fixtureEntries['/index.html'].body, path);
  }
});

test('unsafe MIME/header injection and malformed own entries fail closed without exposing bundled bytes', async () => {
  const unavailableBody = '<script>synthetic-unavailable-body</script>';
  const invalidEntries = [
    { body: unavailableBody, contentType: 'text/html\r\nSet-Cookie: synthetic=1' },
    { body: unavailableBody, contentType: 'text/html; charset=utf-8; synthetic=x' },
    { body: unavailableBody, contentType: 'application/octet-stream' },
    { body: unavailableBody, contentType: 'application/x-synthetic' },
    { body: unavailableBody, contentType: '' },
    { body: unavailableBody, contentType: undefined },
    { body: 42, contentType: 'text/html' },
    { body: undefined, contentType: 'text/html' },
    null,
    undefined,
  ];
  for (const entry of invalidEntries) {
    const files = fixtureFiles();
    files['/assets/invalid.js'] = entry;
    for (const method of ['GET', 'HEAD']) {
      const response = await serveBundledAsset(request('/assets/invalid.js', { method }), files);
      assert.equal(response.status, 500, String(entry?.contentType));
      assertPrivateHeaders(response);
      assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.equal(response.headers.get('set-cookie'), null);
      const body = await response.text();
      assert.ok(!body.includes('synthetic-unavailable-body'), 'invalid entry bytes never become an error body');
      if (method === 'HEAD') assert.equal(body, '');
    }
  }
});

test('allowed alternate JavaScript, JSON and plain-text MIME values stay unchanged and nosniff', async () => {
  for (const contentType of ['text/html', 'text/css', 'text/javascript', 'text/plain', 'application/javascript', 'application/json', 'image/svg+xml']) {
    for (const suffix of ['', '; charset=utf-8']) {
      const files = fixtureFiles();
      files['/assets/synthetic.txt'] = { body: '<svg>synthetic MIME fixture</svg>\n', contentType: contentType + suffix };
      const response = await serveBundledAsset(request('/assets/synthetic.txt'), files);
      assert.equal(response.status, 200, contentType + suffix);
      assertPrivateHeaders(response);
      assert.equal(response.headers.get('content-type'), contentType + suffix);
      assert.equal(await response.text(), files['/assets/synthetic.txt'].body);
    }
  }
});

test('missing index fails closed while an existing own asset remains available', async () => {
  const files = fixtureFiles();
  delete files['/index.html'];
  for (const path of ['/', '/index.html', '/friends']) {
    const response = await serveBundledAsset(request(path), files);
    assert.equal(response.status, 404, path);
    assertPrivateHeaders(response);
  }
  await assertAssetResponse('/assets/app-1a2b3c4d.js', '/assets/app-1a2b3c4d.js', 'GET', files);
});

test('HEAD keeps GET status, MIME and security headers but never emits a body, including 404s', async () => {
  for (const path of Object.keys(fixtureEntries)) await assertAssetResponse(path, path, 'HEAD');
  for (const path of ['/', '/friends/synthetic-id']) await assertAssetResponse(path, '/index.html', 'HEAD');
  for (const path of ['/missing.js', '/assets/missing']) {
    const get = await serveBundledAsset(request(path), fixtureFiles());
    const head = await serveBundledAsset(request(path, { method: 'HEAD' }), fixtureFiles());
    assert.equal(head.status, get.status, path);
    assert.equal(head.status, 404, path);
    assertPrivateHeaders(head);
    assert.equal(head.headers.get('content-type'), get.headers.get('content-type'), path);
    assert.equal((await head.arrayBuffer()).byteLength, 0, path);
  }
});

test('POST, PUT, PATCH, DELETE and OPTIONS all return private 405s for known and unknown paths', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    for (const path of ['/', '/favicon.svg', '/assets/app-1a2b3c4d.js', '/assets/missing.js', '/friends']) {
      const response = await serveBundledAsset(request(path, { method, headers: { 'Content-Type': 'text/html' }, body: 'synthetic-method-body' }), fixtureFiles());
      assert.equal(response.status, 405, method + ' ' + path);
      assertPrivateHeaders(response);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
      const body = await response.text();
      assert.notEqual(body, fixtureEntries['/index.html'].body);
      assert.ok(!body.includes('synthetic-method-body'), 'method rejection never reflects request body');
    }
  }
});

test('main Worker rejects unconfigured, anonymous, forged-header and alternate-origin requests before the bundled adapter', async () => {
  const config = { APP_ORIGIN: origin, ACCESS_TEAM_DOMAIN: 'https://synthetic-bundled-gates.cloudflareaccess.com', ACCESS_AUDIENCE: 'synthetic-bundled-audience', OWNER_EMAIL: 'owner@example.com' };
  let assetCalls = 0, databaseCalls = 0;
  const dependencies = {
    DB: { prepare() { databaseCalls++; throw new Error('unexpected synthetic D1 access'); } },
    ASSETS: { fetch(req) { assetCalls++; return serveBundledAsset(req, fixtureFiles()); } },
  };
  const unconfigured = { ...dependencies, APP_ORIGIN: '', ACCESS_TEAM_DOMAIN: '', ACCESS_AUDIENCE: '', OWNER_EMAIL: '' };
  for (const path of ['/', '/index.html', '/favicon.svg', '/assets/app-1a2b3c4d.js', '/friends', '/api/records?scope=personal']) {
    assert.equal((await worker.fetch(request(path), unconfigured)).status, 503, 'unconfigured ' + path);
    assert.equal((await worker.fetch(request(path), { ...dependencies, ...config })).status, 401, 'anonymous ' + path);
    assert.equal((await worker.fetch(request(path, { headers: { 'oai-authenticated-user-id': 'synthetic-forged-owner', 'oai-authenticated-user-email': config.OWNER_EMAIL, 'Cf-Access-Authenticated-User-Email': config.OWNER_EMAIL, 'X-Forwarded-Host': new URL(origin).host } }), { ...dependencies, ...config })).status, 401, 'forged headers ' + path);
    assert.equal((await worker.fetch(new Request('https://alternate.workers.dev' + path, { headers: { 'Cf-Access-Jwt-Assertion': 'synthetic-invalid-token', 'X-Forwarded-Host': new URL(origin).host } }), { ...dependencies, ...config })).status, 403, 'alternate origin ' + path);
    assert.equal((await worker.fetch(new Request('http://daredakke.example.com' + path), { ...dependencies, ...config })).status, 403, 'wrong scheme ' + path);
  }
  assert.equal(assetCalls, 0, 'all gates run before ASSETS.fetch');
  assert.equal(databaseCalls, 0, 'all gates run before D1');
});

test('main Worker exposes bundled assets only after real owner JWT verification and keeps API/method gates ahead of assets', async () => {
  const config = { APP_ORIGIN: origin, ACCESS_TEAM_DOMAIN: 'https://synthetic-bundled-owner.cloudflareaccess.com', ACCESS_AUDIENCE: 'synthetic-bundled-owner-audience', OWNER_EMAIL: 'owner@example.com' };
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'ephemeral-bundled-assets-key', alg: 'RS256' };
  const now = Math.floor(Date.now() / 1000);
  const token = overrides => new SignJWT({ iss: config.ACCESS_TEAM_DOMAIN, aud: [config.ACCESS_AUDIENCE], sub: 'synthetic-bundled-owner', email: config.OWNER_EMAIL, type: 'app', iat: now, nbf: now - 1, exp: now + 120, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).sign(privateKey);
  let assetCalls = 0, databaseCalls = 0, keyCalls = 0;
  const env = {
    ...config,
    DB: { prepare() { databaseCalls++; throw new Error('unexpected synthetic D1 access'); } },
    ASSETS: { fetch(req) { assetCalls++; return serveBundledAsset(req, fixtureFiles()); } },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), config.ACCESS_TEAM_DOMAIN + '/cdn-cgi/access/certs', 'JWT public keys come only from the configured issuer');
    keyCalls++;
    return Response.json({ keys: [jwk] });
  };
  try {
    const ownerToken = await token({});
    const headers = { 'Cf-Access-Jwt-Assertion': ownerToken };
    for (const [path, key] of [['/', '/index.html'], ['/friends', '/index.html'], ...Object.keys(fixtureEntries).map(path => [path, path])]) {
      const before = assetCalls;
      const response = await worker.fetch(request(path, { headers }), env);
      assert.equal(response.status, 200, path);
      assert.equal(assetCalls, before + 1, 'owner request reaches the adapter exactly once');
      assertPrivateHeaders(response);
      assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.equal(response.headers.get('content-type'), fixtureEntries[key].contentType, path);
      assert.equal(await response.text(), fixtureEntries[key].body, path);
    }
    const head = await worker.fetch(request('/assets/app-1a2b3c4d.js', { method: 'HEAD', headers }), env);
    assert.equal(head.status, 200);
    assertPrivateHeaders(head);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const beforeDenied = assetCalls;
    for (const invalid of ['synthetic-invalid-token', await token({ email: 'other@example.com' }), await token({ aud: ['synthetic-other-audience'] }), await token({ exp: now - 30 })]) {
      for (const path of ['/', '/favicon.svg', '/assets/app-1a2b3c4d.js']) {
        assert.equal((await worker.fetch(request(path, { headers: { 'Cf-Access-Jwt-Assertion': invalid } }), env)).status, 401, path);
      }
    }
    assert.equal((await worker.fetch(new Request('https://alternate.workers.dev/favicon.svg', { headers }), env)).status, 403, 'even a valid owner token cannot bypass the configured origin');
    assert.equal((await worker.fetch(request('/api/session', { headers }), env)).status, 200);
    assert.equal((await worker.fetch(request('/api/unknown', { headers }), env)).status, 404);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.equal((await worker.fetch(request('/favicon.svg', { method, headers }), env)).status, 405, method);
    }
    assert.equal(assetCalls, beforeDenied, 'invalid owner, alternate origin, API and unsupported methods never touch bundled assets');
    assert.equal(databaseCalls, 0);
    assert.equal(keyCalls, 1, 'owner requests reuse the bounded public-key cache');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
