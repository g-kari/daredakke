import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { verifyOwnerToken } from '../src/worker/auth.ts';
import { readAuthConfig } from '../src/worker/config.ts';
import { handleRecords } from '../src/worker/records-api.ts';
import {
  change, demoData, empty, exportData, mergePeople, normalizeAccount,
  parseImport, undoChange, validateState,
} from '../src/domain/records.ts';

// Every identity, key and record below is synthetic. Separate single-owner
// configurations simulate future admission without changing the real gate.
const baseEnv = {
  APP_ORIGIN: 'https://daredakke.example.com',
  ACCESS_TEAM_DOMAIN: 'https://synthetic-team.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'synthetic-isolation-audience',
  OWNER_EMAIL: 'synthetic-a@example.com',
};
const configA = readAuthConfig(baseEnv);
const configB = readAuthConfig({ ...baseEnv, OWNER_EMAIL: 'synthetic-b@example.com' });
assert.ok(configA);
assert.ok(configB);
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey);
jwk.kid = 'ephemeral-isolation-key';
jwk.alg = 'RS256';
const keys = createLocalJWKSet({ keys: [jwk] });

const namespaceFor = (issuer, subject) => 'u_' + createHash('sha256')
  .update(JSON.stringify([issuer, subject]), 'utf8').digest('hex');

async function tokenFor(config, subject, claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: config.issuer, aud: [config.audience], sub: subject,
    email: config.ownerEmail, type: 'app', iat: now, nbf: now - 1,
    exp: now + 300, ...claims,
  }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).sign(privateKey);
}

async function identities() {
  const a = {
    config: configA,
    owner: await verifyOwnerToken(await tokenFor(configA, 'synthetic-subject-a'), configA, keys),
  };
  const b = {
    config: configB,
    owner: await verifyOwnerToken(await tokenFor(configB, 'synthetic-subject-b'), configB, keys),
  };
  assert.ok(a.owner, 'A is accepted by its own single-owner configuration');
  assert.ok(b.owner, 'B is accepted by its own single-owner configuration');
  assert.notEqual(a.owner.ownerId, b.owner.ownerId, 'verified identities must have different namespaces');
  return { a, b };
}

async function withDatabase(fn) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("synthetic isolation tests only"); } }',
    compatibilityDate: '2026-10-09',
    d1Databases: { DB: 'ephemeral-isolation-' + randomUUID() },
    d1Persist: false,
  }));
  try {
    const db = await mf.getD1Database('DB');
    const migration = fs.readFileSync(new URL('../migrations/0001_record_documents.sql', import.meta.url), 'utf8');
    await db.prepare(migration.trim()).run();
    await fn(db, await identities());
  } finally {
    await mf.dispose();
  }
}

async function getDocument(db, identity, scope, query = {}) {
  const url = new URL(identity.config.origin + '/api/records');
  for (const [name, value] of Object.entries({ scope, ...query })) url.searchParams.set(name, value);
  const response = await handleRecords(new Request(url), db, identity.owner, identity.config);
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.equal(document.namespace, identity.owner.ownerId, 'GET reports the authenticated namespace');
  return document;
}

async function postDocument(db, identity, scope, state, revision, extra = {}, query = {}) {
  const url = new URL(identity.config.origin + '/api/records');
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return handleRecords(new Request(url, {
    method: 'POST',
    headers: {
      origin: identity.config.origin,
      'content-type': 'application/json',
      'x-friend-record': '1',
    },
    body: JSON.stringify({
      scope, revision, state, expectedNamespace: identity.owner.ownerId, ...extra,
    }),
  }), db, identity.owner, identity.config);
}

async function saveDocument(db, identity, scope, state, revision, extra = {}, query = {}) {
  const response = await postDocument(db, identity, scope, state, revision, extra, query);
  assert.equal(response.status, 200, await response.text());
  const current = await getDocument(db, identity, scope);
  assert.equal(current.revision, revision + 1);
  assert.deepEqual(current.state, validateState(state));
  return current;
}

async function rows(db) {
  return (await db.prepare('SELECT owner_id, scope, document, revision, updated_at FROM record_documents ORDER BY owner_id, scope').all()).results;
}

function syntheticData(label) {
  return {
    people: [
      { id: 'shared-person-one', name: label + ' One', aliases: ['Synthetic One'], tags: ['synthetic'], notes: label + ' private note one', color: '#4f5fcb' },
      { id: 'shared-person-two', name: label + ' Two', aliases: ['Synthetic Two'], tags: ['synthetic'], notes: label + ' private note two', color: '#147d89' },
    ],
    accounts: [
      { id: 'shared-account-one', service: 'Discord', label: 'Synthetic One', personId: 'shared-person-one', ...normalizeAccount('Discord', '100000000000000101') },
      { id: 'shared-account-two', service: 'Discord', label: 'Synthetic Two', personId: 'shared-person-two', ...normalizeAccount('Discord', '100000000000000101') },
    ],
  };
}

test('namespace hashes only the validated issuer and verified subject; admission stays single-owner', async () => {
  const subject = 'synthetic-subject-a';
  const token = await tokenFor(configA, subject, { ownerId: 'forged-owner', namespace: 'forged-namespace' });
  const first = await verifyOwnerToken(token, configA, keys);
  assert.deepEqual(first, { ownerId: namespaceFor(configA.issuer, subject), subject });
  assert.match(first.ownerId, /^u_[0-9a-f]{64}$/);
  assert.deepEqual(await verifyOwnerToken(await tokenFor(configA, subject), configA, keys), first);

  const otherSubject = await verifyOwnerToken(await tokenFor(configA, 'synthetic-subject-b'), configA, keys);
  assert.notEqual(otherSubject.ownerId, first.ownerId);
  const otherIssuer = readAuthConfig({ ...baseEnv, ACCESS_TEAM_DOMAIN: 'https://another-synthetic-team.cloudflareaccess.com' });
  assert.ok(otherIssuer);
  const otherTeamOwner = await verifyOwnerToken(await tokenFor(otherIssuer, subject), otherIssuer, keys);
  assert.equal(otherTeamOwner.ownerId, namespaceFor(otherIssuer.issuer, subject));
  assert.notEqual(otherTeamOwner.ownerId, first.ownerId);

  const otherEmailAndAudience = readAuthConfig({ ...baseEnv, OWNER_EMAIL: configB.ownerEmail, ACCESS_AUDIENCE: 'another-synthetic-audience' });
  assert.ok(otherEmailAndAudience);
  assert.deepEqual(await verifyOwnerToken(await tokenFor(otherEmailAndAudience, subject), otherEmailAndAudience, keys), first);
  const normalizedIssuer = readAuthConfig({ ...baseEnv, ACCESS_TEAM_DOMAIN: baseEnv.ACCESS_TEAM_DOMAIN + '/' });
  assert.ok(normalizedIssuer);
  assert.deepEqual(await verifyOwnerToken(await tokenFor(normalizedIssuer, subject), normalizedIssuer, keys), first);

  const bToken = await tokenFor(configB, 'synthetic-subject-b');
  assert.equal(await verifyOwnerToken(bToken, configA, keys), null, 'B is not admitted by A’s OWNER_EMAIL gate');
  assert.ok(await verifyOwnerToken(bToken, configB, keys));
  assert.equal(await verifyOwnerToken(await tokenFor(configA, subject, { sub: '' }), configA, keys), null);
});

test('A/B personal and demo records initialize and persist as four independent D1 documents', async () => {
  await withDatabase(async (db, { a, b }) => {
    const expected = [];
    for (const [label, identity] of [['A', a], ['B', b]]) {
      for (const scope of ['personal', 'demo']) {
        const initial = await getDocument(db, identity, scope);
        assert.equal(initial.revision, 0);
        assert.deepEqual(initial.state, { data: scope === 'personal' ? empty() : demoData(), undo: [] });
        const data = scope === 'personal' ? syntheticData(label) : structuredClone(initial.state.data);
        if (scope === 'demo') data.people[0].notes = label + ' synthetic demo-only note';
        const state = change(initial.state, data, 'synthetic seed ' + label + ' ' + scope);
        const document = await saveDocument(db, identity, scope, state, initial.revision);
        expected.push({ identity, scope, document });
      }
    }
    for (const { identity, scope, document } of expected) {
      assert.deepEqual(await getDocument(db, identity, scope), document);
    }
    const stored = await rows(db);
    assert.equal(stored.length, 4);
    assert.deepEqual(new Set(stored.map(row => row.owner_id)), new Set([a.owner.ownerId, b.owner.ownerId]));
    assert.ok(stored.every(row => row.revision === 1));
  });
});

test('forged owner fields and URL selectors cannot route reads or writes to another owner', async () => {
  await withDatabase(async (db, { a, b }) => {
    const aInitial = await getDocument(db, a, 'personal');
    const bInitial = await getDocument(db, b, 'personal');
    const aSeed = await saveDocument(db, a, 'personal', change(aInitial.state, syntheticData('A'), 'seed A'), 0);
    const bSeed = await saveDocument(db, b, 'personal', change(bInitial.state, syntheticData('B'), 'seed B'), 0);
    const query = { ownerId: b.owner.ownerId, owner_id: b.owner.ownerId, namespace: b.owner.ownerId, expectedNamespace: b.owner.ownerId };
    assert.deepEqual(await getDocument(db, a, 'personal', query), aSeed);

    const next = change(aSeed.state, syntheticData('A edited'), 'edit A');
    const aEdited = await saveDocument(db, a, 'personal', next, bSeed.revision, {
      ownerId: b.owner.ownerId, owner_id: b.owner.ownerId,
      namespace: b.owner.ownerId, subject: b.owner.subject,
    }, query);
    assert.deepEqual(await getDocument(db, a, 'personal'), aEdited);
    assert.deepEqual(await getDocument(db, b, 'personal'), bSeed);
    const stored = await rows(db);
    assert.equal(stored.find(row => row.owner_id === a.owner.ownerId).revision, 2);
    assert.equal(stored.find(row => row.owner_id === b.owner.ownerId).revision, 1);
  });
});

test('missing, malformed or changed identity namespaces are rejected before any D1 access or change', async () => {
  await withDatabase(async (db, { a, b }) => {
    for (const identity of [a, b]) {
      await getDocument(db, identity, 'personal');
      await getDocument(db, identity, 'demo');
    }
    const before = await rows(db);
    let touches = 0;
    const forbiddenDB = new Proxy(db, {
      get() { touches++; throw new Error('rejected request must not access D1'); },
    });
    const malformed = [
      undefined, null, true, 7, {}, [], '', 'owner',
      'u_' + 'a'.repeat(63), 'u_' + 'a'.repeat(65),
      'u_' + 'A'.repeat(64), ' u_' + 'a'.repeat(64), 'u_' + 'a'.repeat(64) + ' ',
    ];
    for (const scope of ['personal', 'demo']) {
      for (const expectedNamespace of malformed) {
        const response = await postDocument(forbiddenDB, a, scope, { data: syntheticData('malformed attempt'), undo: [] }, 0, { expectedNamespace });
        assert.equal(response.status, 400, 'malformed namespace: ' + JSON.stringify(expectedNamespace));
      }
      for (const [identity, expectedNamespace] of [
        [a, b.owner.ownerId], [b, a.owner.ownerId], [a, 'u_' + '0'.repeat(64)],
      ]) {
        const response = await postDocument(forbiddenDB, identity, scope, { data: syntheticData('wrong owner attempt'), undo: [] }, 0, { expectedNamespace });
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, 'identity_changed');
      }
    }
    assert.equal(touches, 0, 'namespace rejection happens before even reading a D1 method');
    assert.deepEqual(await rows(db), before, 'document, revision, timestamp and row count are unchanged');
  });
});

test('equal revision numbers cannot overwrite B and stale A revisions leave both owners unchanged', async () => {
  await withDatabase(async (db, { a, b }) => {
    const aInitial = await getDocument(db, a, 'personal');
    const bInitial = await getDocument(db, b, 'personal');
    const aSeed = await saveDocument(db, a, 'personal', change(aInitial.state, syntheticData('A'), 'seed A'), 0);
    const bSeed = await saveDocument(db, b, 'personal', change(bInitial.state, syntheticData('B'), 'seed B'), 0);
    assert.equal(aSeed.revision, bSeed.revision);
    const before = await rows(db);
    const identityChanged = await postDocument(db, b, 'personal', aSeed.state, aSeed.revision, { expectedNamespace: a.owner.ownerId });
    assert.equal(identityChanged.status, 409);
    assert.equal((await identityChanged.json()).code, 'identity_changed');
    assert.deepEqual(await rows(db), before);

    const edited = change(aSeed.state, syntheticData('A next'), 'edit A');
    await saveDocument(db, a, 'personal', edited, bSeed.revision, { ownerId: b.owner.ownerId });
    assert.deepEqual(await getDocument(db, b, 'personal'), bSeed);
    const afterEdit = await rows(db);
    const stale = await postDocument(db, a, 'personal', aSeed.state, aSeed.revision);
    assert.equal(stale.status, 409);
    assert.deepEqual(await rows(db), afterEdit);
  });
});

test('each owner’s merge, undo, export and import are confined to the chosen personal/demo document', async () => {
  await withDatabase(async (db, { a, b }) => {
    const documents = [];
    for (const [label, identity] of [['A', a], ['B', b]]) {
      for (const scope of ['personal', 'demo']) {
        const initial = await getDocument(db, identity, scope);
        const data = scope === 'personal' ? syntheticData(label) : structuredClone(initial.state.data);
        if (scope === 'demo') data.people[0].notes = label + ' isolated synthetic demo';
        documents.push({ label, identity, scope, current: await saveDocument(db, identity, scope, change(initial.state, data, 'seed'), 0) });
      }
    }
    const assertAllCurrent = async () => {
      for (const entry of documents) assert.deepEqual(await getDocument(db, entry.identity, entry.scope), entry.current);
    };
    for (const entry of documents) {
      const original = entry.current.state;
      const target = original.data.people[0].id;
      const source = entry.scope === 'demo' ? 'demo-ao' : original.data.people[1].id;
      const merged = change(original, mergePeople(original.data, target, source), 'merge');
      entry.current = await saveDocument(db, entry.identity, entry.scope, merged, entry.current.revision);
      assert.equal(entry.current.state.data.people.length, original.data.people.length - 1);
      assert.equal(entry.current.state.data.accounts.length, original.data.accounts.length);
      assert.ok(entry.current.state.data.accounts.every(account => account.personId !== source));
      await assertAllCurrent();

      entry.current = await saveDocument(db, entry.identity, entry.scope, undoChange(entry.current.state), entry.current.revision);
      assert.deepEqual(entry.current.state, original);
      await assertAllCurrent();

      const exported = exportData(entry.current.state.data);
      const envelope = JSON.parse(exported);
      assert.deepEqual(Object.keys(envelope).sort(), ['data', 'exportedAt', 'format', 'version']);
      assert.equal(envelope.undo, undefined);
      assert.ok(!exported.includes(a.owner.ownerId));
      assert.ok(!exported.includes(b.owner.ownerId));
      assert.deepEqual(parseImport(exported), original.data);

      // Foreign identity metadata is not an import selector and is stripped.
      envelope.ownerId = b.owner.ownerId;
      envelope.namespace = b.owner.ownerId;
      envelope.data.ownerId = b.owner.ownerId;
      envelope.data.people[0].ownerId = b.owner.ownerId;
      envelope.data.accounts[0].namespace = b.owner.ownerId;
      envelope.data.people[0].name = entry.label + ' imported into ' + entry.scope;
      const imported = parseImport(JSON.stringify(envelope));
      assert.equal(imported.ownerId, undefined);
      assert.equal(imported.people[0].ownerId, undefined);
      assert.equal(imported.accounts[0].namespace, undefined);
      entry.current = await saveDocument(db, entry.identity, entry.scope, change(entry.current.state, imported, 'import'), entry.current.revision);
      await assertAllCurrent();
      entry.current = await saveDocument(db, entry.identity, entry.scope, undoChange(entry.current.state), entry.current.revision);
      assert.deepEqual(entry.current.state, original);
      await assertAllCurrent();
    }
  });
});

test('unknown owner fields are stripped from persisted state, undo and exported records', async () => {
  await withDatabase(async (db, { a, b }) => {
    const initial = await getDocument(db, a, 'personal');
    const seed = await saveDocument(db, a, 'personal', change(initial.state, syntheticData('A original'), 'synthetic seed'), initial.revision);
    const state = change(seed.state, syntheticData('A edited'), 'synthetic edit');
    const dirty = structuredClone(state);
    dirty.ownerId = b.owner.ownerId;
    dirty.namespace = b.owner.ownerId;
    dirty.data.ownerId = b.owner.ownerId;
    dirty.data.people[0].ownerId = b.owner.ownerId;
    dirty.data.accounts[0].namespace = b.owner.ownerId;
    dirty.undo[0].namespace = b.owner.ownerId;
    dirty.undo[0].data.ownerId = b.owner.ownerId;
    dirty.undo[0].data.people[0].ownerId = b.owner.ownerId;
    dirty.undo[0].data.accounts[0].namespace = b.owner.ownerId;
    await saveDocument(db, a, 'personal', dirty, seed.revision, { ownerId: b.owner.ownerId });
    const stored = await rows(db);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].owner_id, a.owner.ownerId);
    assert.deepEqual(JSON.parse(stored[0].document), state, 'unknown fields are absent in D1, not merely hidden by GET');
    const exported = exportData(dirty.data);
    assert.ok(!exported.includes(a.owner.ownerId));
    assert.ok(!exported.includes(b.owner.ownerId));
    assert.deepEqual(parseImport(exported), state.data);
  });
});
