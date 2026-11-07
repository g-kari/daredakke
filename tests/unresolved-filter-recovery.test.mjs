import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createRecordSearch } from '../src/domain/search.ts';

// Exercise the actual UI filter and recovery callback with synthetic ports.
// This is not a replacement for the built desktop/mobile browser regression.
const source = fs.readFileSync(process.env.UNRESOLVED_FILTER_APP || new URL('../src/app.tsx', import.meta.url), 'utf8');
const declaration = name => {
  const line = source.split('\n').find(line => line.startsWith(`  const ${name} = `));
  assert.ok(line, `actual ${name} declaration is required`);
  return line;
};
const start = source.indexOf('  function clearUnresolvedFilters() {');
const end = source.indexOf('  function confirmMerge(', start);
assert.ok(start !== -1 && end > start, 'actual recovery function is required');
const recoveryCode = source.slice(start, end);
const records = () => ({
  people: [{ id: 'person', name: 'Linked person' }],
  accounts: [
    { id: 'x', service: 'X', label: 'Nebula Signal', url: 'https://x.com/nebula_fixture', personId: null },
    { id: 'vrc', service: 'VRChat', label: 'Unknown Garden', url: 'https://vrchat.com/home/user/usr_fixture', personId: null },
    { id: 'linked', service: 'Discord', label: 'Linked voice', url: 'https://discord.com/users/123', personId: 'person' },
  ],
});
function harness(query = 'missing', serviceFilter = 'all', data = records()) {
  const calls = [];
  const c = {
    query, serviceFilter, data, tab: 'unresolved', busy: false, state: { data, undo: [{ label: 'existing history' }] },
    namespace: 'fixture-A', namespaceRef: { current: 'fixture-A' }, sessionPending: { current: false },
    personDraft: null, accountDraft: null, importOpen: false, exportOpen: false, confirmation: null, discard: null,
    searchInput: { current: { focus: () => calls.push('focus') } },
    setQuery: value => { c.query = value; calls.push(['query', value]); },
    setServiceFilter: value => { c.serviceFilter = value; calls.push(['service', value]); },
  };
  const filtered = new Function('data', 'query', 'serviceFilter', 'createRecordSearch', [
    declaration('unresolved'), declaration('search'), declaration('match'), declaration('accountMatch'), declaration('filteredUnresolved'),
  ].map(code => stripTypeScriptTypes(code)).join('\n') + '\nreturn { unresolved, filteredUnresolved };');
  const refresh = () => Object.assign(c, filtered(c.data, c.query, c.serviceFilter, createRecordSearch));
  const run = () => { refresh(); return new Function(...Object.keys(c), recoveryCode + '; return clearUnresolvedFilters;')(...Object.values(c))(); };
  refresh(); return { c, calls, run, refresh };
}
for (const [query, service] of [['missing', 'all'], ['', 'Discord'], ['Nebula', 'VRChat'], ['　\t ', 'Discord']]) {
  test(`explicit recovery clears hiding query/service and focuses search: ${JSON.stringify([query, service])}`, () => {
    const h = harness(query, service), before = structuredClone(h.c.state);
    assert.equal(h.c.unresolved.length, 2); assert.equal(h.c.filteredUnresolved.length, 0);
    h.run(); assert.deepEqual(h.calls, [['query', ''], ['service', 'all'], 'focus']);
    h.refresh(); assert.equal(h.c.filteredUnresolved.length, 2); assert.equal(h.c.tab, 'unresolved');
    assert.deepEqual(h.c.state, before); assert.equal(h.c.data, h.c.state.data);
    h.run(); assert.equal(h.calls.length, 3, 'repeated/stale action must not focus or change anything again');
  });
}
for (const [query, service] of [['Nebula', 'all'], ['', 'X'], ['　\t ', 'all']]) {
  test(`visible records never offer a recovery callback effect: ${JSON.stringify([query, service])}`, () => {
    const h = harness(query, service); h.run(); assert.deepEqual(h.calls, []);
    assert.equal(h.c.query, query); assert.equal(h.c.serviceFilter, service);
  });
}
for (const data of [{ people: [], accounts: [] }, { ...records(), accounts: records().accounts.filter(a => a.personId) }]) {
  test('true-empty unorganized data remains onboarding even with active filters', () => {
    const h = harness('missing', 'X', data); h.run(); assert.equal(h.c.unresolved.length, 0);
    assert.deepEqual(h.calls, []); assert.equal(h.c.query, 'missing'); assert.equal(h.c.serviceFilter, 'X');
  });
}
for (const guard of ['busy', 'sessionPending', 'state', 'namespace', 'changed namespace', 'tab', 'personDraft', 'accountDraft', 'importOpen', 'exportOpen', 'confirmation', 'discard']) {
  test(`${guard} prevents reset and focus without altering records or inputs`, () => {
    const h = harness('missing', 'VRChat'), before = structuredClone(h.c.state);
    if (guard === 'sessionPending') h.c.sessionPending.current = true;
    else if (guard === 'changed namespace') h.c.namespaceRef.current = 'fixture-B';
    else if (guard === 'state' || guard === 'namespace') h.c[guard] = null;
    else if (guard === 'tab') h.c.tab = 'people';
    else h.c[guard] = ['personDraft', 'accountDraft', 'confirmation', 'discard'].includes(guard) ? { input: 'keep unsaved' } : true;
    const input = h.c.personDraft || h.c.accountDraft || h.c.confirmation || h.c.discard;
    h.run(); assert.deepEqual(h.calls, []); assert.equal(h.c.query, 'missing'); assert.equal(h.c.serviceFilter, 'VRChat');
    assert.deepEqual(h.c.data, before.data);
    if (h.c.state) assert.deepEqual(h.c.state, before);
    assert.equal(h.c.personDraft || h.c.accountDraft || h.c.confirmation || h.c.discard, input);
  });
}
test('a missing search element cannot throw or schedule a later focus', () => {
  const h = harness(); h.c.searchInput.current = null; h.run();
  assert.deepEqual(h.calls, [['query', ''], ['service', 'all']]);
});
test('render uses true totals for distinct recovery/onboarding and one shared filtered list', () => {
  const start = source.indexOf('<TabsContent value="unresolved">'), end = source.indexOf('<TabsContent value="duplicates">', start);
  const ui = source.slice(start, end);
  assert.match(source, /<Input ref=\{searchInput\} disabled=\{busy\} value=\{query\}/);
  assert.match(ui, /filteredUnresolved\.map/); assert.match(ui, /state && !filteredUnresolved\.length/);
  assert.match(ui, /unresolved\.length \? '一致する未整理アカウントがありません' : '未整理アカウントはありません'/);
  assert.match(ui, /unresolved\.length \? <Button variant="outline" onClick=\{clearUnresolvedFilters\} disabled=\{busy\}/);
  assert.doesNotMatch(recoveryCode, /\b(save|update|fetch|change|setState|setRevision|setTab|setSelected|setTimeout|requestAnimationFrame)\s*\(/);
});
