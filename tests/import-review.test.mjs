import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImportReview } from '../src/domain/import-review.ts';

// All fixtures are synthetic and independent of production/demo or owner data.
const color = '#4f5fcb';
const blank = () => ({ people: [], accounts: [] });
const person = (id = 'p1', overrides = {}) => ({
  id, name: `Synthetic ${id}`, aliases: [], tags: [], notes: '', color, ...overrides,
});
const account = (id = 'a1', overrides = {}) => ({
  id, service: 'X', label: `Synthetic ${id}`, url: 'https://x.com/synthetic_test',
  key: 'X:synthetic_test', personId: 'p1', ...overrides,
});
const fixture = () => ({ people: [person()], accounts: [account()] });
const envelope = (data, overrides = {}) => ({ format: 'daredakke', version: 1, data, ...overrides });
const json = (data, overrides = {}) => JSON.stringify(envelope(data, overrides));
const counts = (before, after, added, updated, removed, unchanged) => ({
  before, after, added, updated, removed, unchanged,
});
const clone = value => structuredClone(value);
function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') deepFreeze(child);
  }
  return Object.freeze(value);
}
function assertCounts(review, people, accounts) {
  assert.deepEqual(review.people, people);
  assert.deepEqual(review.accounts, accounts);
  for (const summary of [review.people, review.accounts]) {
    assert.equal(summary.after, summary.added + summary.updated + summary.unchanged);
    assert.equal(summary.before, summary.removed + summary.updated + summary.unchanged);
  }
}

test('an identical replacement reports all records unchanged and returns validated data', () => {
  const current = fixture();
  const review = buildImportReview(current, json(current));
  assertCounts(review, counts(1, 1, 0, 0, 0, 1), counts(1, 1, 0, 0, 0, 1));
  assert.deepEqual(review.data, current);
  assert.deepEqual({
    format: review.format, unresolved: review.unresolved, duplicateGroups: review.duplicateGroups,
    duplicateAccounts: review.duplicateAccounts, empty: review.empty,
  }, { format: 'daredakke', unresolved: 0, duplicateGroups: 0, duplicateAccounts: 0, empty: false });
  assert.notEqual(review.data, current);
  assert.notEqual(review.data.people[0], current.people[0]);
  assert.notEqual(review.data.accounts[0], current.accounts[0]);
});

test('mixed additions, updates, removals and unchanged records have independent counts', () => {
  const current = {
    people: [person('keep'), person('edit'), person('remove')],
    accounts: [account('keep-a', { personId: 'keep' }), account('edit-a', { personId: 'edit' }), account('remove-a', { personId: 'remove' })],
  };
  const incoming = {
    people: [person('keep'), person('edit', { notes: 'New synthetic note' }), person('add')],
    accounts: [account('keep-a', { personId: 'keep' }), account('edit-a', { personId: 'edit', label: 'Changed label' }), account('add-a', { personId: 'add' })],
  };
  const review = buildImportReview(current, json(incoming));
  assertCounts(review, counts(3, 3, 1, 1, 1, 1), counts(3, 3, 1, 1, 1, 1));
  assert.deepEqual(review.data, incoming);
});

test('same names and account URLs with different IDs are additions and removals', () => {
  const current = fixture();
  const incoming = {
    people: [person('replacement', { name: current.people[0].name })],
    accounts: [account('replacement-a', { label: current.accounts[0].label, personId: 'replacement' })],
  };
  const review = buildImportReview(current, json(incoming));
  assertCounts(review, counts(1, 1, 1, 0, 1, 0), counts(1, 1, 1, 0, 1, 0));
  assert.equal(review.data.people[0].id, 'replacement');
  assert.equal(review.data.accounts[0].personId, 'replacement');
});

test('ID matching is case-sensitive and does not use aliases, labels or profile URLs', () => {
  const current = { people: [person('Person')], accounts: [account('Account', { personId: 'Person' })] };
  const incoming = { people: [person('person', { name: current.people[0].name, aliases: ['Person'] })], accounts: [account('account', { label: current.accounts[0].label, personId: 'person' })] };
  assertCounts(buildImportReview(current, json(incoming)), counts(1, 1, 1, 0, 1, 0), counts(1, 1, 1, 0, 1, 0));
});

for (const [field, value] of Object.entries({
  name: 'Renamed synthetic person', notes: 'Changed synthetic note', aliases: ['New alias'],
  tags: ['New tag'], color: '#147d89',
})) {
  test(`a changed person ${field} counts as one update`, () => {
    const current = fixture(), incoming = clone(current);
    incoming.people[0][field] = value;
    assertCounts(buildImportReview(current, json(incoming)), counts(1, 1, 0, 1, 0, 0), counts(1, 1, 0, 0, 0, 1));
  });
}

for (const [field, patch] of Object.entries({
  service: { service: 'Discord', url: '100000000000000001' },
  label: { label: 'Changed synthetic account' }, url: { url: '@another_test' }, personId: { personId: 'p2' },
})) {
  test(`a changed account ${field} counts as one update`, () => {
    const current = { people: [person(), person('p2')], accounts: [account()] }, incoming = clone(current);
    Object.assign(incoming.accounts[0], patch);
    assertCounts(buildImportReview(current, json(incoming)), counts(2, 2, 0, 0, 0, 2), counts(1, 1, 0, 1, 0, 0));
  });
}

test('several changed fields on one identity still count as one update', () => {
  const current = fixture(), incoming = clone(current);
  Object.assign(incoming.people[0], { name: 'Different name', notes: 'Different notes', aliases: ['Alias'], tags: ['Tag'], color: '#147d89' });
  Object.assign(incoming.accounts[0], { label: 'Different label', url: '@another_test', personId: null });
  const review = buildImportReview(current, json(incoming));
  assertCounts(review, counts(1, 1, 0, 1, 0, 0), counts(1, 1, 0, 1, 0, 0));
  assert.equal(review.unresolved, 1);
});

test('reassignment to null and back preserves account identity and changes unresolved count', () => {
  const linked = fixture(), unresolved = clone(linked);
  unresolved.accounts[0].personId = null;
  const unlinkedReview = buildImportReview(linked, json(unresolved));
  const linkedReview = buildImportReview(unresolved, json(linked));
  for (const review of [unlinkedReview, linkedReview]) {
    assertCounts(review, counts(1, 1, 0, 0, 0, 1), counts(1, 1, 0, 1, 0, 0));
  }
  assert.equal(unlinkedReview.unresolved, 1);
  assert.equal(linkedReview.unresolved, 0);
});

test('removing a person and explicitly detaching its retained account is valid replacement data', () => {
  const review = buildImportReview(fixture(), json({ people: [], accounts: [account('a1', { personId: null })] }));
  assertCounts(review, counts(1, 0, 0, 0, 1, 0), counts(1, 1, 0, 1, 0, 0));
  assert.equal(review.unresolved, 1);
  assert.equal(review.empty, false);
});

test('person and account row order does not count as an update', () => {
  const current = { people: [person(), person('p2')], accounts: [account(), account('a2', { personId: 'p2', url: 'https://x.com/another_test', key: 'X:another_test' })] };
  const incoming = { people: [...current.people].reverse(), accounts: [...current.accounts].reverse() };
  const review = buildImportReview(current, json(incoming));
  assertCounts(review, counts(2, 2, 0, 0, 0, 2), counts(2, 2, 0, 0, 0, 2));
  assert.deepEqual(review.data, incoming);
});

for (const field of ['aliases', 'tags']) {
  test(`${field} display-order changes count as a person update`, () => {
    const current = { people: [person('p1', { [field]: ['First', 'Second'] })], accounts: [] };
    const incoming = clone(current);
    incoming.people[0][field].reverse();
    const review = buildImportReview(current, json(incoming));
    assertCounts(review, counts(1, 1, 0, 1, 0, 0), counts(0, 0, 0, 0, 0, 0));
    assert.deepEqual(review.data.people[0][field], ['Second', 'First']);
  });
}

test('canonical field order, trimming, deduplication, fallback color and derived keys do not invent updates', () => {
  const current = {
    people: [{ color: 'invalid-color', notes: '  Note\n', tags: [' Tag ', '', 'Tag'], aliases: [' Alias ', 'Alias', ' '], name: ' Synthetic p1 ', id: ' p1 ', ignored: true }],
    accounts: [{ personId: ' p1 ', key: 'untrusted-derived-key', url: 'https://www.twitter.com/SYNTHETIC_TEST/?ref=synthetic#anchor', label: ' Synthetic a1 ', service: 'X', id: ' a1 ', ignored: true }],
  };
  const incoming = {
    people: [person('p1', { notes: 'Note', tags: ['Tag'], aliases: ['Alias'] })],
    accounts: [account()],
  };
  const review = buildImportReview(current, json(incoming));
  assertCounts(review, counts(1, 1, 0, 0, 0, 1), counts(1, 1, 0, 0, 0, 1));
  assert.deepEqual(review.data, incoming);
  assert.deepEqual(Object.keys(review.data.people[0]), ['id', 'name', 'aliases', 'tags', 'notes', 'color']);
  assert.deepEqual(Object.keys(review.data.accounts[0]), ['id', 'service', 'label', 'url', 'key', 'personId']);
});

for (const [service, currentUrl, incomingUrl, normalizedUrl, normalizedKey] of [
  ['X', '@Synthetic_test', 'https://twitter.com/SYNTHETIC_TEST/?synthetic=1#test', 'https://x.com/synthetic_test', 'X:synthetic_test'],
  ['Discord', '100000000000000001', 'https://www.discord.com/users/100000000000000001/?synthetic=1', 'https://discord.com/users/100000000000000001', 'Discord:100000000000000001'],
  ['VRChat', 'usr_00000000-0000-4000-8000-00000000000a', 'https://www.vrchat.com/home/user/USR_00000000-0000-4000-8000-00000000000A/?synthetic=1', 'https://vrchat.com/home/user/usr_00000000-0000-4000-8000-00000000000a', 'VRChat:usr_00000000-0000-4000-8000-00000000000a'],
]) {
  test(`equivalent ${service} account input is unchanged after normalization`, () => {
    const current = { people: [person()], accounts: [account('a1', { service, url: currentUrl, key: 'ignored-old-key' })] };
    const incoming = { people: [person()], accounts: [account('a1', { service, url: incomingUrl, key: 'ignored-new-key' })] };
    const review = buildImportReview(current, json(incoming));
    assertCounts(review, counts(1, 1, 0, 0, 0, 1), counts(1, 1, 0, 0, 0, 1));
    assert.equal(review.data.accounts[0].url, normalizedUrl);
    assert.equal(review.data.accounts[0].key, normalizedKey);
  });
}

test('duplicate summaries use normalized service keys, retain all identities and count incoming unresolved accounts', () => {
  const incoming = {
    people: [person('p1', { name: 'Shared synthetic name' }), person('p2', { name: 'Shared synthetic name' })],
    accounts: [
      account('x1'), account('x2', { url: '@SYNTHETIC_TEST', personId: 'p2' }),
      account('x3', { url: 'https://twitter.com/Synthetic_test?ref=synthetic', personId: null }),
      account('d1', { service: 'Discord', url: '100000000000000001' }),
      account('d2', { service: 'Discord', url: 'https://discord.com/users/100000000000000001/', personId: null }),
      account('unique', { url: '@unique_test' }),
    ],
  };
  const review = buildImportReview(blank(), json(incoming));
  assertCounts(review, counts(0, 2, 2, 0, 0, 0), counts(0, 6, 6, 0, 0, 0));
  assert.equal(review.duplicateGroups, 2);
  assert.equal(review.duplicateAccounts, 5);
  assert.equal(review.unresolved, 2);
  assert.equal(review.data.people.length, 2);
  assert.deepEqual(review.data.accounts.map(a => a.id), ['x1', 'x2', 'x3', 'd1', 'd2', 'unique']);
  assert.deepEqual(review.data.accounts.map(a => a.personId), ['p1', 'p2', null, 'p1', null, 'p1']);
});

test('incoming summaries do not retain current-only duplicates or unresolved accounts', () => {
  const current = { people: [], accounts: [account('a1', { personId: null }), account('a2', { personId: null })] };
  const review = buildImportReview(current, json(fixture()));
  assertCounts(review, counts(0, 1, 1, 0, 0, 0), counts(2, 1, 0, 1, 1, 0));
  assert.equal(review.duplicateGroups, 0);
  assert.equal(review.duplicateAccounts, 0);
  assert.equal(review.unresolved, 0);
});

test('empty replacement distinguishes clearing existing data from an already-empty input', () => {
  const cleared = buildImportReview(fixture(), json(blank()));
  assertCounts(cleared, counts(1, 0, 0, 0, 1, 0), counts(1, 0, 0, 0, 1, 0));
  const unchanged = buildImportReview(blank(), json(blank()));
  assertCounts(unchanged, counts(0, 0, 0, 0, 0, 0), counts(0, 0, 0, 0, 0, 0));
  for (const review of [cleared, unchanged]) {
    assert.equal(review.empty, true);
    assert.equal(review.unresolved, 0);
    assert.equal(review.duplicateGroups, 0);
    assert.equal(review.duplicateAccounts, 0);
    assert.deepEqual(review.data, blank());
  }
  assert.equal(buildImportReview(blank(), json({ people: [person()], accounts: [] })).empty, false);
  assert.equal(buildImportReview(blank(), json({ people: [], accounts: [account('a1', { personId: null })] })).empty, false);
});

test('source format is exposed as a format label without trusting exportedAt or ownership claims', () => {
  for (const format of ['daredakke', 'friend-record']) {
    for (const exportedAt of [undefined, 'not a timestamp', '1900-01-01', '2999-12-31', { owner: 'synthetic-forged-owner' }]) {
      const review = buildImportReview(fixture(), json(fixture(), { format, exportedAt, owner: 'synthetic-forged-owner', authentic: true, trusted: true }));
      assert.equal(review.format, format);
      assertCounts(review, counts(1, 1, 0, 0, 0, 1), counts(1, 1, 0, 0, 0, 1));
      assert.deepEqual(Object.keys(review).sort(), ['accounts', 'data', 'duplicateAccounts', 'duplicateGroups', 'empty', 'format', 'people', 'unresolved'].sort());
    }
  }
});

test('unknown and prototype-named fields are stripped without polluting output or global prototypes', () => {
  const pollutionKey = 'syntheticImportReviewPollution';
  const extra = { secret: 'synthetic ignored value', ['__proto__']: { [pollutionKey]: true }, constructor: { prototype: { [pollutionKey]: true } }, prototype: { [pollutionKey]: true } };
  const incoming = { ...extra, people: [{ ...person(), ...extra }], accounts: [{ ...account(), ...extra }] };
  const review = buildImportReview(fixture(), json(incoming, extra));
  assertCounts(review, counts(1, 1, 0, 0, 0, 1), counts(1, 1, 0, 0, 0, 1));
  assert.deepEqual(review.data, fixture());
  for (const object of [review, review.data, ...review.data.people, ...review.data.accounts]) {
    assert.equal(Object.getPrototypeOf(object), Object.prototype);
    assert.equal(Object.hasOwn(object, '__proto__'), false);
    assert.equal(Object.hasOwn(object, 'constructor'), false);
    assert.equal(Object.hasOwn(object, 'prototype'), false);
    assert.equal(Object.hasOwn(object, 'secret'), false);
  }
  assert.equal(Object.hasOwn(Object.prototype, pollutionKey), false);
  assert.equal(({})[pollutionKey], undefined);
});

test('prototype-named IDs remain exact, distinct Map identities', () => {
  const ids = ['__proto__', 'constructor', 'toString'];
  const current = { people: ids.map(id => person(id)), accounts: ids.map(id => account(id, { personId: id })) };
  const incoming = clone(current);
  incoming.people[0].notes = 'Changed prototype-named identity';
  incoming.accounts[1].label = 'Changed constructor-named identity';
  const review = buildImportReview(current, json(incoming));
  assertCounts(review, counts(3, 3, 0, 1, 0, 2), counts(3, 3, 0, 1, 0, 2));
  assert.deepEqual(review.data.people.map(p => p.id), ids);
  assert.deepEqual(review.data.accounts.map(a => a.id), ids);
});

test('frozen current records and frozen incoming objects stay unchanged and output shares no mutable arrays', () => {
  const current = deepFreeze({ people: [person('p1', { aliases: ['First'], tags: ['Synthetic'] })], accounts: [account()] });
  const incoming = deepFreeze({ people: [person('p1', { aliases: ['Second'], tags: ['Synthetic'] })], accounts: [account('a1', { personId: null })] });
  const currentSnapshot = JSON.stringify(current), incomingSnapshot = JSON.stringify(incoming), input = json(incoming);
  const review = buildImportReview(current, input);
  assert.equal(JSON.stringify(current), currentSnapshot);
  assert.equal(JSON.stringify(incoming), incomingSnapshot);
  assert.equal(input, json(incoming));
  assert.notEqual(review.data.people, current.people);
  assert.notEqual(review.data.people[0].aliases, current.people[0].aliases);
  assert.notEqual(review.data.people[0].tags, current.people[0].tags);
  review.data.people[0].aliases.push('Output-only mutation');
  review.data.people[0].tags.push('Output-only tag');
  review.data.accounts[0].label = 'Output-only label';
  assert.equal(JSON.stringify(current), currentSnapshot);
  assert.equal(JSON.stringify(incoming), incomingSnapshot);
});

test('plain text and allowed note newlines/tabs are preserved without control-character corruption', () => {
  const incoming = { people: [person('p1', { name: '<img src=x onerror=synthetic()>', notes: 'First line\n\tSecond line <script>synthetic()</script>' })], accounts: [account()] };
  const review = buildImportReview(blank(), json(incoming));
  assert.equal(review.data.people[0].name, incoming.people[0].name);
  assert.equal(review.data.people[0].notes, incoming.people[0].notes);
});

test('invalid JSON, unsupported format/version and invalid envelopes are rejected', () => {
  const invalid = [
    '', ' ', '{bad', '{"format":"daredakke",', 'null', '[]', '42', '"string"',
    JSON.stringify({ version: 1, data: blank() }),
    JSON.stringify(envelope(blank(), { format: 'other' })),
    JSON.stringify(envelope(blank(), { format: ['daredakke'] })),
    JSON.stringify(envelope(blank(), { version: 0 })),
    JSON.stringify(envelope(blank(), { version: 2 })),
    JSON.stringify(envelope(blank(), { version: '1' })),
    JSON.stringify(envelope(blank(), { version: null })),
    JSON.stringify({ format: 'daredakke', data: blank() }),
    JSON.stringify({ format: 'daredakke', version: 1 }),
    JSON.stringify(envelope(null)), JSON.stringify(envelope([])),
    JSON.stringify(envelope({ people: [], accounts: 'not an array' })),
    JSON.stringify(envelope({ people: 'not an array', accounts: [] })),
  ];
  for (const input of invalid) assert.throws(() => buildImportReview(blank(), input), Error, input.slice(0, 120));
});

test('malformed IDs, records, arrays, references, URLs and null-byte fields are rejected', () => {
  const mutations = [
    ['dangling person ID', d => { d.accounts[0].personId = 'missing'; }],
    ['case-mismatched person ID', d => { d.accounts[0].personId = 'P1'; }],
    ['blank person reference', d => { d.accounts[0].personId = ''; }],
    ['missing person reference', d => { delete d.accounts[0].personId; }],
    ['duplicate person ID', d => { d.people.push(clone(d.people[0])); }],
    ['duplicate account ID', d => { d.accounts.push(clone(d.accounts[0])); }],
    ['reserved person ID', d => { d.people[0].id = 'none'; }],
    ['invalid person ID', d => { d.people[0].id = '../p1'; }],
    ['invalid account ID', d => { d.accounts[0].id = ''; }],
    ['blank name', d => { d.people[0].name = ' '; }],
    ['non-string name', d => { d.people[0].name = 42; }],
    ['missing notes', d => { delete d.people[0].notes; }],
    ['invalid aliases array', d => { d.people[0].aliases = 'alias'; }],
    ['invalid tag element', d => { d.people[0].tags = [null]; }],
    ['null person row', d => { d.people[0] = null; }],
    ['array account row', d => { d.accounts[0] = []; }],
    ['unsupported service', d => { d.accounts[0].service = 'other'; }],
    ['array service', d => { d.accounts[0].service = ['X']; }],
    ['unsafe URL', d => { d.accounts[0].url = 'javascript:synthetic()'; }],
    ['unexpected URL host', d => { d.accounts[0].url = 'https://synthetic.invalid/profile'; }],
    ['URL embedded control', d => { d.accounts[0].url = 'https://x.com/synthetic\n_test'; }],
    ['null-byte name', d => { d.people[0].name = 'Synthetic\u0000name'; }],
    ['null-byte notes', d => { d.people[0].notes = 'Synthetic\u0000note'; }],
    ['null-byte alias', d => { d.people[0].aliases = ['Synthetic\u0000alias']; }],
    ['null-byte tag', d => { d.people[0].tags = ['Synthetic\u0000tag']; }],
    ['null-byte label', d => { d.accounts[0].label = 'Synthetic\u0000label'; }],
  ];
  for (const [label, mutate] of mutations) {
    const incoming = fixture();
    mutate(incoming);
    const snapshot = JSON.stringify(incoming);
    assert.throws(() => buildImportReview(blank(), json(incoming)), Error, label);
    assert.equal(JSON.stringify(incoming), snapshot, `${label}: incoming remains unchanged`);
  }
});

test('current data is validated rather than silently accepting invalid existing identities or references', () => {
  for (const [label, mutate] of [
    ['dangling current account', d => { d.accounts[0].personId = 'missing'; }],
    ['duplicate current person IDs', d => { d.people.push(clone(d.people[0])); }],
    ['duplicate current account IDs', d => { d.accounts.push(clone(d.accounts[0])); }],
    ['invalid current URL', d => { d.accounts[0].url = 'http://x.com/synthetic_test'; }],
  ]) {
    const current = fixture();
    mutate(current);
    const snapshot = JSON.stringify(current);
    assert.throws(() => buildImportReview(current, json(blank())), Error, label);
    assert.equal(JSON.stringify(current), snapshot, `${label}: current remains unchanged`);
  }
  for (const current of [null, [], {}, { people: [], accounts: null }]) {
    assert.throws(() => buildImportReview(current, json(blank())), Error);
  }
});

test('field and list limits reject oversized input before a review is returned', () => {
  const mutations = [
    d => { d.people[0].name = 'n'.repeat(101); },
    d => { d.people[0].notes = 'n'.repeat(6001); },
    d => { d.people[0].aliases = ['a'.repeat(81)]; },
    d => { d.people[0].tags = Array.from({ length: 21 }, (_, i) => `tag-${i}`); },
    d => { d.people[0].aliases = Array.from({ length: 21 }, (_, i) => `alias-${i}`); },
    d => { d.accounts[0].label = 'l'.repeat(101); },
    d => { d.accounts[0].id = 'i'.repeat(81); },
    d => { d.accounts[0].url = `https://x.com/synthetic_test?pad=${'u'.repeat(500)}`; },
  ];
  for (const mutate of mutations) {
    const incoming = fixture();
    mutate(incoming);
    assert.throws(() => buildImportReview(blank(), json(incoming)), Error);
  }
  assert.throws(() => buildImportReview(blank(), json({ people: Array.from({ length: 201 }, (_, i) => person(`p${i}`)), accounts: [] })), Error);
  assert.throws(() => buildImportReview(blank(), json({ people: [], accounts: Array.from({ length: 1001 }, (_, i) => account(`a${i}`, { personId: null })) })), Error);
  assert.throws(() => buildImportReview({ people: Array.from({ length: 201 }, (_, i) => person(`p${i}`)), accounts: [] }, json(blank())), Error);
  assert.throws(() => buildImportReview({ people: [], accounts: Array.from({ length: 1001 }, (_, i) => account(`a${i}`, { personId: null })) }, json(blank())), Error);
});

test('field and list lengths exactly at supported limits remain valid', () => {
  const id = 'p'.repeat(80), prefix = 'https://x.com/synthetic_test?padding=';
  const incoming = {
    people: [person(id, {
      name: 'n'.repeat(100), notes: 'n'.repeat(6000),
      aliases: Array.from({ length: 20 }, (_, i) => `${String(i).padStart(2, '0')}${'a'.repeat(78)}`),
      tags: Array.from({ length: 20 }, (_, i) => `${String(i).padStart(2, '0')}${'t'.repeat(78)}`),
    })],
    accounts: [account('a'.repeat(80), { personId: id, label: 'l'.repeat(100), url: prefix + 'u'.repeat(500 - prefix.length) })],
  };
  assert.equal(incoming.accounts[0].url.length, 500);
  const review = buildImportReview(blank(), json(incoming));
  assertCounts(review, counts(0, 1, 1, 0, 0, 0), counts(0, 1, 1, 0, 0, 0));
  assert.deepEqual(review.data.people, incoming.people);
  assert.equal(review.data.accounts[0].url, 'https://x.com/synthetic_test');
  assert.equal(review.data.accounts[0].personId, id);
});

test('JSON size limit is exactly 900000 UTF-8 bytes, including otherwise ignored fields', () => {
  const overhead = Buffer.byteLength(json(blank(), { padding: '' }), 'utf8');
  const atLimit = json(blank(), { padding: 'x'.repeat(900000 - overhead) });
  assert.equal(Buffer.byteLength(atLimit, 'utf8'), 900000);
  assert.equal(buildImportReview(blank(), atLimit).empty, true);
  const overLimit = json(blank(), { padding: 'x'.repeat(900001 - overhead) });
  assert.equal(Buffer.byteLength(overLimit, 'utf8'), 900001);
  assert.throws(() => buildImportReview(blank(), overLimit), /900KB/);
  const multibyte = json(blank(), { padding: '架'.repeat(300000) });
  assert.ok(multibyte.length < 900000);
  assert.ok(Buffer.byteLength(multibyte, 'utf8') > 900000);
  assert.throws(() => buildImportReview(blank(), multibyte), /900KB/);
});

test('maximum supported record counts produce exact counts without positional identity inference', () => {
  const current = {
    people: Array.from({ length: 200 }, (_, i) => person(`p${i}`)),
    accounts: Array.from({ length: 1000 }, (_, i) => account(`a${i}`, { personId: `p${i % 150}`, url: `https://x.com/test_${i}`, key: `X:test_${i}` })),
  };
  const incoming = {
    people: [...clone(current.people.slice(0, 150)), ...Array.from({ length: 50 }, (_, i) => person(`p${200 + i}`))],
    accounts: [...clone(current.accounts.slice(0, 800)), ...Array.from({ length: 200 }, (_, i) => account(`a${1000 + i}`, { personId: `p${200 + (i % 50)}`, url: `https://x.com/test_${1000 + i}`, key: `X:test_${1000 + i}` }))],
  };
  incoming.people[0].name = 'Changed synthetic p0';
  for (const a of incoming.accounts.slice(0, 10)) a.label = `Changed synthetic ${a.id}`;
  incoming.people.reverse();
  incoming.accounts.reverse();
  const snapshot = JSON.stringify(current);
  const review = buildImportReview(deepFreeze(current), json(deepFreeze(incoming)));
  assertCounts(review, counts(200, 200, 50, 1, 50, 149), counts(1000, 1000, 200, 10, 200, 790));
  assert.equal(review.unresolved, 0);
  assert.equal(review.duplicateGroups, 0);
  assert.equal(review.duplicateAccounts, 0);
  assert.equal(review.empty, false);
  assert.equal(JSON.stringify(current), snapshot);
  assert.deepEqual(review.data, incoming);
});
