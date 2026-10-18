import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { normalizeAccount, change, demoData } from '../src/domain/records.ts';
import { createRecordSearch, searchPeople } from '../src/domain/search.ts';

// Execute the actual component callback and selection declarations. This is not
// a browser/layout test and does not use authentication, network or real D1.
const source = ts.createSourceFile('app.tsx', fs.readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map(), declarations = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  ts.forEachChild(node, visit);
}
visit(source);
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const submit = functions.get('submitAccount'); assert.ok(submit);
const selectCode = ['unresolved', 'search', 'match', 'filteredPeople', 'desktopPerson', 'accountMatch'].map(name => {
  assert.ok(declarations.has(name)); return 'const ' + declarations.get(name).getText(source) + ';';
}).join('\n');
const select = new Function('data', 'query', 'serviceFilter', 'selected', 'createRecordSearch', 'searchPeople', compile(selectCode + ';return {unresolved:unresolved.filter(accountMatch), filteredPeople, desktopPerson};'));
const newDraft = owner => ({ service: 'Discord', label: 'Created voice', url: '100000000000000009', personId: owner });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function harness({ query = '', service = 'all', tab = 'people', owner = 'none', succeeds = true, pending = null, edit = false, draft: supplied, afterAccepted = null } = {}) {
  const data = demoData(), draft = supplied || (edit ? { ...data.accounts[0], personId: data.accounts[0].personId || 'none', label: 'Edited voice' } : newDraft(owner));
  const before = structuredClone(data);
  const view = { query, serviceFilter: service, tab, selected: 'demo-sora', accountDraft: draft, state: { data, undo: [] }, notices: [], error: '', clears: [] };
  const updates = [];
  const context = { data, accountDraft: draft, normalizeAccount, createRecordSearch, searchPeople,
    filtersRef: { current: { query, serviceFilter: service } }, profileFocus: { current: null }, accountReveal: { current: null }, accountDialog: { current: { isConnected: true } }, identityEpoch: { current: 0 }, namespaceRef: { current: 'synthetic-owner-A' },
    crypto: { randomUUID: () => 'synthetic-created-account' }, accountDraftInitial: { current: draft },
    clearDraftFocus: kind => view.clears.push(kind), setFormError: value => { view.error = value; },
    toast: { info: value => view.notices.push(value) },
    update: async (next, label) => { const candidate = change(view.state, next, label); updates.push({candidate, label}); if (pending) await pending.promise; if (!succeeds) return false; view.state = candidate; if (afterAccepted) afterAccepted(view, context); return true; },
  };
  for (const name of ['Query', 'ServiceFilter', 'Tab', 'Selected', 'AccountDraft']) {
    const key = name[0].toLowerCase() + name.slice(1); context['set' + name] = value => { view[key] = value; };
  }
  const callback = new Function(...Object.keys(context), compile(submit.getText(source)) + ';return submitAccount;')(...Object.values(context));
  return { view, before, context, updates, run: () => callback({ preventDefault() {} }),
    render: () => select(view.state.data, view.query, view.serviceFilter, view.selected, createRecordSearch, searchPeople) };
}
function expectOneCreated(h, owner) {
  assert.equal(h.updates.length, 1); assert.equal(h.updates[0].label, 'アカウントを追加しました');
  assert.equal(h.view.state.undo.length, 1); assert.deepEqual(h.view.state.undo[0].data, h.before);
  assert.deepEqual(h.view.state.data.people, h.before.people);
  assert.deepEqual(h.view.state.data.accounts.slice(0, h.before.accounts.length), h.before.accounts);
  const created = h.view.state.data.accounts.filter(a => a.id === 'synthetic-created-account');
  assert.equal(created.length, 1); assert.equal(created[0].personId, owner === 'none' ? null : owner);
  assert.equal(h.view.accountDraft, null); assert.deepEqual(h.view.clears, ['account']);
  if (owner === 'none') {
    assert.equal(h.view.tab, 'unresolved'); assert.equal(h.view.selected, null);
    assert.ok(h.render().unresolved.some(a => a.id === created[0].id));
  } else {
    assert.equal(h.view.tab, 'people'); assert.equal(h.view.selected, owner);
    assert.equal(h.render().desktopPerson.id, owner);
    assert.ok(h.render().filteredPeople.some(p => p.id === owner));
    assert.ok(h.view.state.data.accounts.some(a => a.id === created[0].id && a.personId === h.view.selected));
    assert.equal(h.context.profileFocus.current.personId, owner);
  }
}

for (const owner of ['none', 'demo-yuki']) for (const tab of ['people', 'unresolved', 'duplicates']) {
  for (const service of ['all', 'Discord', 'X', 'VRChat']) for (const [query, queryMatches] of [['', true], ['  CREATED\u3000voice  ', true], ['not-the-created-record', false]]) {
    test(`new account reveals ${owner} from ${tab}, service=${service}, query=${JSON.stringify(query)}`, async () => {
      const h = harness({ owner, tab, service, query }); await h.run(); expectOneCreated(h, owner);
      assert.equal(h.view.query, queryMatches ? query : '');
      // yuki already has X, so that filter can remain while showing their full profile.
      const serviceMatches = service === 'all' || service === 'Discord' || owner === 'demo-yuki' && service === 'X';
      assert.equal(h.view.serviceFilter, serviceMatches ? service : 'all');
      assert.equal(h.view.notices.length, !queryMatches || !serviceMatches ? 1 : 0);
    });
  }
}
test('owner fields and a different existing owner account can satisfy a matching query', async () => {
  for (const query of ['  ゆき 制作  ', '@fr_demo_yuki']) {
    const h = harness({ owner: 'demo-yuki', query, service: 'X' }); await h.run(); expectOneCreated(h, 'demo-yuki');
    assert.equal(h.view.query, query); assert.equal(h.view.serviceFilter, 'X'); assert.deepEqual(h.view.notices, []);
  }
});
test('failed new account does not clear filters, select owner or close input', async () => {
  for (const owner of ['none', 'demo-yuki']) {
    const h = harness({ owner, query: 'no-match', service: 'VRChat', tab: 'duplicates', succeeds: false });
    await h.run(); assert.equal(h.updates.length, 1); assert.deepEqual(h.view.state.data, h.before); assert.equal(h.view.state.undo.length, 0);
    assert.equal(h.view.query, 'no-match'); assert.equal(h.view.serviceFilter, 'VRChat'); assert.equal(h.view.tab, 'duplicates');
    assert.equal(h.view.selected, 'demo-sora'); assert.ok(h.view.accountDraft); assert.deepEqual(h.view.clears, []); assert.deepEqual(h.view.notices, []);
  }
});
test('pending save does not navigate; latest still-active filters determine successful reveal', async () => {
  const gate = deferred(), h = harness({ query: 'missing', service: 'VRChat', pending: gate });
  const result = h.run(); assert.equal(h.view.tab, 'people'); assert.equal(h.view.query, 'missing'); assert.ok(h.view.accountDraft);
  h.context.filtersRef.current = { query: 'CREATED', serviceFilter: 'Discord' }; h.view.query = 'CREATED'; h.view.serviceFilter = 'Discord';
  gate.resolve(); await result; expectOneCreated(h, 'none'); assert.equal(h.view.query, 'CREATED'); assert.equal(h.view.serviceFilter, 'Discord'); assert.deepEqual(h.view.notices, []);
});
test('existing account editing preserves navigation, selection and filters', async () => {
  for (const succeeds of [true, false]) {
    const h = harness({ query: 'missing', service: 'VRChat', tab: 'duplicates', edit: true, succeeds }); await h.run();
    assert.equal(h.updates.length, 1); assert.equal(h.updates[0].label, 'アカウントを更新しました');
    assert.equal(h.view.state.data.accounts.length, h.before.accounts.length); assert.equal(h.view.query, 'missing');
    assert.equal(h.view.serviceFilter, 'VRChat'); assert.equal(h.view.tab, 'duplicates'); assert.equal(h.view.selected, 'demo-sora'); assert.deepEqual(h.view.notices, []);
    assert.equal(h.context.profileFocus.current, null);
  }
});
test('validation rejection stays in the input with no update/navigation', async () => {
  const h = harness({ draft: { ...newDraft('none'), url: 'not-a-valid-discord-id' }, query: 'missing', service: 'X' });
  await h.run(); assert.equal(h.updates.length, 0); assert.ok(h.view.error); assert.equal(h.view.tab, 'people'); assert.equal(h.view.query, 'missing'); assert.equal(h.view.serviceFilter, 'X'); assert.ok(h.view.accountDraft);
});
for (const owner of ['none', 'demo-yuki']) for (const identityChange of ['epoch', 'namespace', 'both']) {
  test(`accepted save cannot revive old account reveal after ${identityChange} invalidation for ${owner}`, async () => {
    const h = harness({ owner, query: 'old-query', service: 'VRChat', afterAccepted(view, context) {
      if (identityChange !== 'namespace') context.identityEpoch.current++;
      if (identityChange !== 'epoch') context.namespaceRef.current = 'synthetic-owner-B';
      // Model clearSessionData/new-session UI after the accepted save but before
      // the nested update/submit continuations resume. Never restore A's intent.
      view.state = { data: { people: [], accounts: [] }, undo: [] }; view.accountDraft = null;
      view.query = 'new-session-query'; view.serviceFilter = 'X'; view.tab = 'settings'; view.selected = null;
    } });
    await h.run(); assert.equal(h.updates.length, 1); assert.equal(h.view.state.data.people.length, 0);
    assert.equal(h.view.query, 'new-session-query'); assert.equal(h.view.serviceFilter, 'X'); assert.equal(h.view.tab, 'settings');
    assert.equal(h.view.selected, null); assert.equal(h.context.profileFocus.current, null); assert.deepEqual(h.view.notices, []); assert.deepEqual(h.view.clears, []);
  });
}

// Execute the actual one-shot reveal scheduler with synthetic frame/DOM ports.
function revealHarness(overrides = {}) {
  const calls = [], frames = new Map(); let serial = 0;
  const target = { isConnected: true, focus: options => calls.push(['focus', options]), scrollIntoView: options => calls.push(['scroll', options]) };
  const intent = { id: 'created', personId: null, epoch: 7, namespace: 'owner', ready: true, query: '', serviceFilter: 'all' };
  const context = { accountReveal: { current: intent }, accountRows: { current: new Map([['created', target]]) }, accountRevealFrame: { current: null }, stateRef: { current: { data: { accounts: [{ id: 'created' }] } } }, identityEpoch: { current: 7 }, namespaceRef: { current: 'owner' }, sessionPending: { current: false }, checkingSession: false, tab: 'unresolved', selected: null, revealView: { current: { tab: 'unresolved', selected: null } }, filtersRef: { current: { query: '', serviceFilter: 'all' } },
    requestAnimationFrame: callback => { frames.set(++serial, callback); return serial; }, cancelAnimationFrame: id => frames.delete(id), ...overrides };
  const run = new Function('c', `with(c) { ${compile(functions.get('revealCreatedAccount').getText(source))}; revealCreatedAccount(); }`);
  return { context, intent, target, calls, run: () => run(context), flush: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); }, frames };
}
test('accepted new-account reveal focuses and scrolls once, then consumes intent', () => {
  const h = revealHarness(); h.run(); assert.equal(h.calls.length, 0); h.flush();
  assert.deepEqual(h.calls, [['focus', { preventScroll: true }], ['scroll', { block: 'center', behavior: 'auto' }]]);
  assert.equal(h.context.accountReveal.current, null); h.run(); h.flush(); assert.equal(h.calls.length, 2);
});
for (const key of ['epoch', 'namespace', 'tab', 'owner', 'removed']) test(`reveal cancels stale ${key} before scheduling`, () => {
  const h = revealHarness();
  if (key === 'epoch') h.context.identityEpoch.current++;
  if (key === 'namespace') h.context.namespaceRef.current = 'other';
  if (key === 'tab') h.context.tab = 'people';
  if (key === 'owner') h.context.selected = 'other';
  if (key === 'removed') { h.context.accountRows.current.clear(); h.context.stateRef.current.data.accounts = []; }
  h.run(); h.flush(); assert.deepEqual(h.calls, []); assert.equal(h.context.accountReveal.current, null);
});
for (const key of ['identity', 'namespace', 'pending', 'disconnected', 'new-intent', 'query', 'service', 'navigation']) test(`scheduled reveal cannot run after ${key} changes`, () => {
  const h = revealHarness(); h.run();
  if (key === 'identity') h.context.identityEpoch.current++;
  if (key === 'namespace') h.context.namespaceRef.current = 'other';
  if (key === 'pending') h.context.sessionPending.current = true;
  if (key === 'disconnected') h.target.isConnected = false;
  if (key === 'new-intent') h.context.accountReveal.current = { ...h.intent };
  if (key === 'query') h.context.filtersRef.current.query = 'new';
  if (key === 'service') h.context.filtersRef.current.serviceFilter = 'X';
  if (key === 'navigation') h.context.revealView.current.tab = 'people';
  h.flush(); assert.deepEqual(h.calls, []);
});
test('same-owner verification defers reveal, then resumes without a save', () => {
  const h = revealHarness(); h.context.sessionPending.current = true; h.run(); assert.equal(h.frames.size, 0); assert.equal(h.context.accountReveal.current, h.intent);
  h.context.sessionPending.current = false; h.run(); h.flush(); assert.equal(h.calls.length, 2);
});
test('account modal close is required before scheduling reveal', () => {
  const h = revealHarness(); h.intent.ready = false; h.run(); h.flush(); assert.deepEqual(h.calls, []);
  h.intent.ready = true; h.run(); h.flush(); assert.equal(h.calls.length, 2);
});
test('repeated scheduling replaces the older frame instead of focusing twice', () => {
  const h = revealHarness(); h.run(); h.run(); assert.equal(h.frames.size, 1); h.flush(); assert.equal(h.calls.length, 2);
});

for (const mounted of [true, false]) test(`accepted save tracks whether account modal is still mounted: ${mounted}`, async () => {
  const h = harness({ afterAccepted: (_view, context) => { context.accountDialog.current = mounted ? { isConnected: true } : null; } });
  await h.run(); expectOneCreated(h, 'none');
  assert.equal(h.context.accountReveal.current.ready, !mounted);
  assert.equal(h.context.accountReveal.current.epoch, h.context.identityEpoch.current);
  assert.equal(h.context.accountReveal.current.namespace, h.context.namespaceRef.current);
});

test('a delayed Sheet portal target mount retains the current record intent', () => {
  const h = revealHarness(); h.context.accountRows.current.clear(); h.run();
  assert.equal(h.context.accountReveal.current, h.intent); assert.equal(h.frames.size, 0);
  h.context.accountRows.current.set('created', h.target); h.run(); h.flush(); assert.equal(h.calls.length, 2);
});
