import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { createRecordSearch, searchPeople } from '../src/domain/search.ts';
import { change, colors, demoData, empty } from '../src/domain/records.ts';

// Follow the existing source-bound callback regressions. These tests execute the
// actual component callback and actual list/detail selection declarations. They
// do not simulate a rendered browser, real authentication, fetch or D1.
const source = ts.createSourceFile('app.tsx', fs.readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map(), declarations = new Map();
let closeProfileNode, personRowRef;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'SheetContent') {
    closeProfileNode = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.text === 'onCloseAutoFocus')?.initializer?.expression;
  }
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'button' && node.attributes.properties.some(property => ts.isJsxAttribute(property) && property.name.text === 'className' && property.initializer?.getText(source).includes("'person-row'"))) {
    personRowRef = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.text === 'ref')?.initializer?.expression;
  }
  ts.forEachChild(node, visit);
}
visit(source);
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const submitNode = functions.get('submitPerson');
assert.ok(submitNode, 'the actual submitPerson callback must exist');
const selectionCode = ['search', 'filteredPeople', 'desktopPerson'].map(name => {
  assert.ok(declarations.has(name), `the actual ${name} declaration must exist`);
  return 'const ' + declarations.get(name).getText(source) + ';';
}).join('\n');
const select = new Function('data', 'query', 'serviceFilter', 'selected', 'createRecordSearch', 'searchPeople', compile(selectionCode + '\nreturn { filteredPeople, desktopPerson };'));
const newDraft = () => ({ name: '追加した人', aliases: 'Created Alias', tags: '制作', notes: 'Created note [literal].+$' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function harness({ query = '', serviceFilter = 'all', tab = 'people', data = demoData(), draft = newDraft(), succeeds = true, pending = null } = {}) {
  const before = structuredClone(data);
  const view = { query, serviceFilter, tab, selected: data.people[0]?.id ?? null, personDraft: draft, state: { data, undo: [] }, cleared: [], notices: [] };
  const updates = [];
  const context = {
    data, personDraft: draft, query, serviceFilter, tab,
    filtersRef: { current: { query, serviceFilter } },
    profileFocus: { current: null }, identityEpoch: { current: 0 }, sessionPending: { current: false },
    colors, crypto: { randomUUID: () => 'synthetic-created-id' },
    createRecordSearch, searchPeople,
    split: value => value.split(/[,、\n]/).map(part => part.trim()).filter(Boolean),
    personDraftInitial: { current: newDraft() },
    clearDraftFocus: kind => view.cleared.push(kind),
    toast: { info: message => view.notices.push(message), success: message => view.notices.push(message) },
    update: async (next, label) => {
      // Use the actual record validation/history function, not a copied rule.
      const candidate = change(view.state, next, label);
      updates.push({ candidate, label });
      if (pending) await pending.promise;
      if (!succeeds) return false;
      view.state = candidate;
      return true;
    },
  };
  for (const name of ['Query', 'ServiceFilter', 'Tab', 'Selected', 'PersonDraft']) {
    const key = name[0].toLowerCase() + name.slice(1);
    context['set' + name] = value => { view[key] = value; };
  }
  const run = new Function(...Object.keys(context), compile(submitNode.getText(source)) + '\nreturn submitPerson;')(...Object.values(context));
  const render = () => select(view.state.data, view.query, view.serviceFilter, view.selected, createRecordSearch, searchPeople);
  const changeFilters = next => {
    Object.assign(view, next);
    Object.assign(context.filtersRef.current, next);
  };
  return { context, view, updates, before, run: () => run({ preventDefault() {} }), render, changeFilters };
}
function expectCreated(h) {
  assert.equal(h.updates.length, 1, 'one update only');
  assert.equal(h.updates[0].label, '人を追加しました', 'the history/save operation label stays stable');
  assert.equal(h.view.state.undo.length, 1, 'navigation never creates extra undo history');
  assert.deepEqual(h.view.state.undo[0].data, h.before);
  assert.deepEqual(h.view.state.data.people.slice(0, h.before.people.length), h.before.people, 'existing people unchanged');
  assert.deepEqual(h.view.state.data.accounts, h.before.accounts, 'existing accounts and links unchanged');
  assert.equal(h.view.selected, 'synthetic-created-id');
  assert.equal(h.view.personDraft, null);
  const rendered = h.render();
  assert.ok(rendered.filteredPeople.some(person => person.id === h.view.selected), 'the created selected ID must be in the actual filtered list');
  assert.equal(rendered.desktopPerson?.id, h.view.selected, 'the actual desktop detail must agree with the selected created ID');
  assert.equal(h.view.tab, 'people', 'successful new creation moves to the people tab');
  assert.equal(h.view.serviceFilter, 'all', 'the new accountless person cannot remain hidden by a service');
}

for (const query of ['', ' \u3000 ', '  CREATED\u3000制作 [literal].+$  ']) {
  test('source-bound new-person success preserves matching raw query ' + JSON.stringify(query), async () => {
    const h = harness({ query }); await h.run(); expectCreated(h);
    assert.equal(h.view.query, query, 'matching search remains byte-for-byte unchanged');
    assert.deepEqual(h.view.notices, [], 'no false filter-change notice when nothing changed');
  });
}
for (const serviceFilter of ['Discord', 'X', 'VRChat']) {
  for (const [query, matches] of [['', true], ['  CREATED\u3000制作  ', true], ['aoi_demo', false]]) {
    test(`source-bound success reveals new ID through ${serviceFilter} with ${matches ? 'matching' : 'nonmatching'} query ${JSON.stringify(query)}`, async () => {
      const h = harness({ query, serviceFilter }); await h.run(); expectCreated(h);
      assert.equal(h.view.query, matches ? query : '');
      assert.match(h.view.notices.join(' '), /サービス/, 'changed service is explained in existing toast feedback');
      if (!matches) assert.match(h.view.notices.join(' '), /検索/, 'cleared search is explained');
    });
  }
}
for (const tab of ['people', 'unresolved', 'duplicates']) {
  test('source-bound nonmatching query is cleared after creation from ' + tab, async () => {
    const h = harness({ query: 'aoi_demo', tab }); await h.run(); expectCreated(h);
    assert.equal(h.view.query, '');
    assert.match(h.view.notices.join(' '), /検索/);
    assert.doesNotMatch(h.view.notices.join(' '), /サービス/, 'unchanged service is not reported as cleared');
  });
}
for (const tab of ['unresolved', 'duplicates']) {
  test('source-bound matching query survives success navigation from ' + tab, async () => {
    const query = '  CREATED\u3000制作  ', h = harness({ query, tab }); await h.run(); expectCreated(h);
    assert.equal(h.view.query, query);
  });
}
test('source-bound empty workspace clears only hiding conditions', async () => {
  const h = harness({ query: 'no_match', serviceFilter: 'VRChat', tab: 'duplicates', data: empty() });
  await h.run(); expectCreated(h);
  assert.equal(h.view.query, ''); assert.match(h.view.notices.join(' '), /検索.*サービス|サービス.*検索/);
});
test('source-bound pending save preserves all input and view until success', async () => {
  const pending = deferred(), h = harness({ query: 'aoi_demo', serviceFilter: 'X', tab: 'duplicates', pending });
  const beforeView = { query: h.view.query, serviceFilter: h.view.serviceFilter, tab: h.view.tab, selected: h.view.selected, draft: h.view.personDraft };
  const saving = h.run();
  assert.equal(h.updates.length, 1);
  assert.deepEqual({ query: h.view.query, serviceFilter: h.view.serviceFilter, tab: h.view.tab, selected: h.view.selected, draft: h.view.personDraft }, beforeView);
  assert.deepEqual(h.view.state.data, h.before); assert.deepEqual(h.view.notices, []);
  pending.resolve(); await saving; expectCreated(h);
});
test('source-bound failed save preserves draft, query, service, tab, selection and history', async () => {
  const h = harness({ query: 'aoi_demo', serviceFilter: 'Discord', tab: 'unresolved', succeeds: false });
  const beforeView = { ...h.view }; await h.run();
  assert.equal(h.updates.length, 1);
  assert.deepEqual(h.view, beforeView);
  assert.notEqual(h.context.personDraftInitial.current, null);
});
for (const [initialQuery, latestQuery, expectedQuery, initialService, latestService] of [
  ['aoi_demo', '  CREATED\u3000制作  ', '  CREATED\u3000制作  ', 'X', 'all'],
  ['CREATED', 'aoi_demo', '', 'all', 'Discord'],
]) test('source-bound pending success uses latest filters rather than submit-time conditions: ' + latestQuery, async () => {
  const pending = deferred(), h = harness({ query: initialQuery, serviceFilter: initialService, pending });
  const saving = h.run();
  h.changeFilters({ query: latestQuery, serviceFilter: latestService });
  pending.resolve(); await saving; expectCreated(h);
  assert.equal(h.view.query, expectedQuery, 'the latest matching raw query is retained; only the currently nonmatching query is cleared');
  if (latestService === 'all') assert.doesNotMatch(h.view.notices.join(' '), /サービス/);
  else assert.match(h.view.notices.join(' '), /サービス/);
});
test('source-bound existing-person edit retains search, service and navigation behavior', async () => {
  const data = demoData(), person = data.people[0];
  const draft = { id: person.id, name: person.name, aliases: person.aliases.join(', '), tags: person.tags.join(', '), notes: 'Edited existing note' };
  const h = harness({ data, draft, query: 'aoi_demo', serviceFilter: 'Discord', tab: 'unresolved' });
  const focus = { target: { isConnected: true, focus() {} }, epoch: 0 };
  h.context.profileFocus.current = focus;
  await h.run();
  assert.equal(h.updates.length, 1); assert.equal(h.updates[0].label, '人の記録を更新しました');
  assert.equal(h.view.query, 'aoi_demo'); assert.equal(h.view.serviceFilter, 'Discord'); assert.equal(h.view.tab, 'unresolved');
  assert.equal(h.view.selected, person.id); assert.equal(h.view.personDraft, null); assert.deepEqual(h.view.notices, []);
  assert.equal(h.view.state.data.people.length, data.people.length);
  assert.deepEqual(h.view.state.data.people[0], { ...person, notes: draft.notes });
  assert.deepEqual(h.view.state.data.accounts, data.accounts);
  assert.equal(h.context.profileFocus.current, focus, 'editing must not replace the existing profile focus target');
});

test('source-bound new profile close focuses its new row instead of a stale previously opened row', async () => {
  assert.ok(closeProfileNode, 'the actual mobile Sheet close callback exists');
  const h = harness();
  let oldFocus = 0, newFocus = 0, prevented = 0;
  const oldRow = { isConnected: true, focus: () => { oldFocus++; } };
  const newRow = { isConnected: true, focus: () => { newFocus++; } };
  h.context.profileFocus.current = { target: oldRow, epoch: 0 };
  await h.run();
  // Invoke the actual row ref if the component uses one. Its absence is not
  // itself the RED: baseline must fail because its actual close callback calls
  // the old target after actual successful creation.
  if (personRowRef) {
    const context = { ...h.context, p: { id: h.view.selected } };
    new Function(...Object.keys(context), compile('return ' + personRowRef.getText(source) + ';'))(...Object.values(context))(newRow);
  }
  new Function(...Object.keys(h.context), compile('return ' + closeProfileNode.getText(source) + ';'))(...Object.values(h.context))({ preventDefault: () => { prevented++; } });
  assert.equal(oldFocus, 0, 'closing the new profile must not restore focus to a different person');
  assert.equal(newFocus, 1, 'the actual new row receives the guarded focus intent');
  assert.equal(prevented, 1);
});

for (const condition of ['same-owner', 'changed-epoch', 'session-pending', 'disconnected']) {
  test('source-bound existing profile focus keeps its ' + condition + ' guard', () => {
    assert.ok(closeProfileNode, 'the actual mobile Sheet close callback exists');
    const h = harness(); let focused = 0, prevented = 0;
    h.context.profileFocus.current = { target: { isConnected: condition !== 'disconnected', focus: () => { focused++; } }, epoch: 0 };
    if (condition === 'changed-epoch') h.context.identityEpoch.current = 1;
    if (condition === 'session-pending') h.context.sessionPending.current = true;
    new Function(...Object.keys(h.context), compile('return ' + closeProfileNode.getText(source) + ';'))(...Object.values(h.context))({ preventDefault: () => { prevented++; } });
    assert.equal(focused, condition === 'same-owner' ? 1 : 0);
    assert.equal(prevented, condition === 'same-owner' ? 1 : 0);
  });
}
