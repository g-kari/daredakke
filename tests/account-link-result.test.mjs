import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { change, demoData, undoChange } from '../src/domain/records.ts';
import { createRecordSearch, searchPeople } from '../src/domain/search.ts';

// Execute the actual non-JSX component functions with synthetic UI/save ports.
// No dependency installation, browser, network, authentication or real D1.
const appPath = process.env.LINK_RESULT_APP || new URL('../src/app.tsx', import.meta.url);
const source = fs.readFileSync(appPath, 'utf8');
function functionSource(name, end) {
  const start = source.indexOf(`  ${name === 'link' ? 'async ' : ''}function ${name}(`);
  assert.notEqual(start, -1, `actual ${name} function is required`);
  const finish = source.indexOf(end, start); assert.notEqual(finish, -1);
  return source.slice(start, finish);
}
const codes = {
  link: functionSource('link', '  function currentLinkResult('),
  currentLinkResult: functionSource('currentLinkResult', '  function openLinkedAccount('),
  openLinkedAccount: functionSource('openLinkedAccount', '  function linkResultContent('),
  revealCreatedAccount: functionSource('revealCreatedAccount', '  useEffect('),
};
const bind = (name, context) => new Function(...Object.keys(context), stripTypeScriptTypes(codes[name]) + `;return ${name};`)(...Object.values(context));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function harness({ success = true, gate = null, afterAccepted = null, query = '', service = 'all', compact = false, selected = null } = {}) {
  const data = demoData(), before = structuredClone(data), calls = [], frames = new Map(); let frame = 0;
  const c = { data, revision: 0, scope: 'demo', busy: false, compactProfile: compact, person: data.people.find(p => p.id === selected),
    personDraft: null, accountDraft: null, importOpen: false, exportOpen: false, confirmation: null, discard: null,
    linkNotice: null, query, serviceFilter: service, selected, tab: selected ? 'people' : 'unresolved',
    identityEpoch: { current: 7 }, namespaceRef: { current: 'synthetic-owner-A' }, sessionPending: { current: false }, checkingSession: false,
    stateRef: { current: { data, undo: [] } }, filtersRef: { current: { query, serviceFilter: service } },
    profileFocus: { current: null }, accountReveal: { current: null }, accountRevealFrame: { current: null }, accountRows: { current: new Map() },
    revealView: { current: { tab: selected ? 'people' : 'unresolved', selected } },
    createRecordSearch, searchPeople, toast: { info: value => calls.push(['info', value]) },
    requestAnimationFrame: callback => { frames.set(++frame, callback); return frame; }, cancelAnimationFrame: id => frames.delete(id),
    setLinkNotice: value => { c.linkNotice = value; },
    setQuery: value => { c.query = value; c.filtersRef.current.query = value; },
    setServiceFilter: value => { c.serviceFilter = value; c.filtersRef.current.serviceFilter = value; },
    setSelected: value => { c.selected = value; c.person = c.data.people.find(p => p.id === value); c.revealView.current.selected = value; },
    setTab: value => { c.tab = value; c.revealView.current.tab = value; },
    update: async (next, label) => {
      calls.push(['update', structuredClone(next), label]); c.busy = true;
      if (gate) await gate.promise;
      c.busy = false; if (!success) return false;
      c.stateRef.current = change(c.stateRef.current, next, label); c.data = c.stateRef.current.data; c.revision++;
      if (afterAccepted) afterAccepted(c); return true;
    },
  };
  c.currentLinkResult = () => bind('currentLinkResult', c)();
  c.revealCreatedAccount = () => bind('revealCreatedAccount', c)();
  return { c, calls, before, frames, link: (id, target) => bind('link', c)(c.data.accounts.find(a => a.id === id), target),
    result: () => c.currentLinkResult(), open: () => bind('openLinkedAccount', c)(), reveal: () => c.revealCreatedAccount(),
    flush: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); } };
}
function view(c) { return [c.tab, c.selected, c.query, c.serviceFilter]; }
function writes(h) { return h.calls.filter(call => call[0] === 'update'); }
for (const [id, target, destination] of [['demo-c7', 'demo-yuki', 'ゆき'], ['demo-c1', 'none', null]]) {
  test(`successful inline relink ${id} names its destination without navigating or changing filters`, async () => {
    const h = harness({ query: 'Original query', service: 'X', selected: 'demo-aoi' }), initialView = view(h.c);
    await h.link(id, target); assert.deepEqual(view(h.c), initialView);
    assert.equal(writes(h).length, 1); assert.equal(h.c.stateRef.current.undo.length, 1);
    assert.deepEqual(h.c.stateRef.current.undo[0].data, h.before);
    assert.equal(h.result().account.id, id); assert.equal(h.result().destination?.name || null, destination);
    assert.equal(writes(h)[0][2], target === 'none' ? '紐づけを解除しました' : 'アカウントを紐づけました');
    assert.equal(h.c.accountReveal.current, null); assert.equal(h.c.profileFocus.current, null);
    assert.deepEqual(h.c.data.people, h.before.people);
    assert.equal(h.c.data.accounts.filter(a => a.id === id)[0].personId, target === 'none' ? null : target);
  });
}
test('pending and failed save produce no result, navigation, reveal or history', async () => {
  const gate = deferred(), h = harness({ success: false, gate, query: 'keep', service: 'VRChat' }), before = view(h.c);
  const pending = h.link('demo-c7', 'demo-yuki'); assert.equal(h.c.busy, true); assert.equal(h.result(), null); assert.deepEqual(view(h.c), before);
  gate.resolve(); await pending; assert.equal(h.result(), null); assert.equal(h.c.accountReveal.current, null);
  assert.deepEqual(view(h.c), before); assert.deepEqual(h.c.data, h.before); assert.equal(h.c.stateRef.current.undo.length, 0); assert.equal(writes(h).length, 1);
});
for (const changeIdentity of [c => c.identityEpoch.current++, c => { c.namespaceRef.current = 'synthetic-owner-B'; }]) {
  test('identity invalidation between accepted save and async continuation cannot create an old result', async () => {
    const h = harness({ afterAccepted: changeIdentity }); await h.link('demo-c7', 'demo-yuki');
    assert.equal(h.c.linkNotice, null); assert.equal(h.result(), null); assert.equal(h.c.accountReveal.current, null);
  });
}
for (const stale of ['epoch', 'namespace', 'scope', 'revision', 'deleted account', 'different target', 'deleted person']) {
  test(`stale ${stale} invalidates result and explicit action`, async () => {
    const h = harness(); await h.link('demo-c7', 'demo-yuki');
    if (stale === 'epoch') h.c.identityEpoch.current++;
    if (stale === 'namespace') h.c.namespaceRef.current = 'synthetic-owner-B';
    if (stale === 'scope') h.c.scope = 'personal';
    if (stale === 'revision') h.c.revision++;
    if (stale === 'deleted account') h.c.data.accounts = h.c.data.accounts.filter(a => a.id !== 'demo-c7');
    if (stale === 'different target') h.c.data.accounts.find(a => a.id === 'demo-c7').personId = 'demo-sora';
    if (stale === 'deleted person') h.c.data.people = h.c.data.people.filter(p => p.id !== 'demo-yuki');
    const before = view(h.c); assert.equal(h.result(), null); h.open(); assert.deepEqual(view(h.c), before);
    assert.equal(h.c.accountReveal.current, null); assert.equal(writes(h).length, 1);
  });
}
for (const guard of ['busy', 'sessionPending', 'personDraft', 'accountDraft', 'importOpen', 'exportOpen', 'confirmation', 'discard']) {
  test(`${guard} blocks the optional action without touching input or records`, async () => {
    const h = harness(); await h.link('demo-c7', 'demo-yuki'); const notice = h.c.linkNotice, before = view(h.c), state = h.c.stateRef.current;
    if (guard === 'sessionPending') h.c.sessionPending.current = true; else h.c[guard] = guard.endsWith('Draft') || ['confirmation', 'discard'].includes(guard) ? { input: 'unsaved' } : true;
    h.open(); assert.deepEqual(view(h.c), before); assert.equal(h.c.linkNotice, notice); assert.equal(h.c.stateRef.current, state); assert.equal(h.c.accountReveal.current, null);
  });
}
for (const linked of [true, false]) for (const queryMatches of [true, false]) for (const serviceMatches of [true, false]) {
  test(`explicit ${linked ? 'linked' : 'unresolved'} navigation preserves matching raw filters q=${queryMatches} service=${serviceMatches}`, async () => {
    const raw = queryMatches ? (linked ? '  ゆき 制作  ' : '  AOI_DEMO  ') : 'missing-destination';
    const service = serviceMatches ? (linked ? 'X' : 'Discord') : (linked ? 'Discord' : 'VRChat');
    const h = harness({ query: raw, service }); await h.link(linked ? 'demo-c7' : 'demo-c1', linked ? 'demo-yuki' : 'none');
    const accepted = structuredClone(h.c.stateRef.current); h.open();
    assert.equal(h.c.tab, linked ? 'people' : 'unresolved'); assert.equal(h.c.selected, linked ? 'demo-yuki' : null);
    assert.equal(h.c.query, queryMatches ? raw : ''); assert.equal(h.c.serviceFilter, serviceMatches ? service : 'all');
    assert.deepEqual(h.c.stateRef.current, accepted); assert.equal(writes(h).length, 1); assert.equal(h.c.linkNotice, null);
    assert.equal(h.c.accountReveal.current.id, linked ? 'demo-c7' : 'demo-c1'); assert.equal(h.c.accountReveal.current.ready, true);
    if (linked) assert.equal(h.c.profileFocus.current.personId, 'demo-yuki');
  });
}
test('mobile unlink waits for actual Sheet close before scheduling one-shot row focus', async () => {
  const h = harness({ compact: true, selected: 'demo-aoi', query: 'あおい', service: 'Discord' });
  await h.link('demo-c1', 'none'); h.open(); assert.equal(h.c.accountReveal.current.ready, false);
  const events = [], target = { isConnected: true, focus: () => events.push('focus'), scrollIntoView: () => events.push('scroll') };
  h.c.accountRows.current.set('demo-c1', target); h.reveal(); assert.equal(h.frames.size, 0);
  const start = source.indexOf('onCloseAutoFocus={event => {', source.indexOf('<SheetContent')) + 'onCloseAutoFocus={'.length;
  const end = source.indexOf('}><SheetHeader>', start); assert.ok(start > 0 && end > start);
  let prevented = 0; const close = new Function(...Object.keys(h.c), 'return (' + source.slice(start, end) + ');')(...Object.values(h.c));
  close({ preventDefault() { prevented++; } }); assert.equal(prevented, 1); assert.equal(h.c.accountReveal.current.ready, true);
  h.flush(); assert.deepEqual(events, ['focus', 'scroll']); assert.equal(h.c.accountReveal.current, null);
  h.reveal(); h.flush(); assert.deepEqual(events, ['focus', 'scroll']); assert.equal(writes(h).length, 1);
});
test('undo invalidates the result even when a later relink restores the same target', async () => {
  const h = harness(); await h.link('demo-c7', 'demo-yuki');
  h.c.stateRef.current = undoChange(h.c.stateRef.current); h.c.data = h.c.stateRef.current.data; h.c.revision++;
  assert.equal(h.result(), null);
  h.c.stateRef.current = change(h.c.stateRef.current, { ...h.c.data, accounts: h.c.data.accounts.map(a => a.id === 'demo-c7' ? { ...a, personId: 'demo-yuki' } : a) }, 'Synthetic later relink');
  h.c.data = h.c.stateRef.current.data; h.c.revision++; assert.equal(h.result(), null);
});
function capturedSheetClose(h) {
  const start = source.indexOf('onCloseAutoFocus={event => {', source.indexOf('<SheetContent')) + 'onCloseAutoFocus={'.length;
  const end = source.indexOf('}><SheetHeader>', start); assert.ok(start > 0 && end > start);
  // A closing modal may retain the render from before explicit navigation.
  const context = { ...h.c, revealCreatedAccount: bind('revealCreatedAccount', h.c) };
  return new Function(...Object.keys(context), 'return (' + source.slice(start, end) + ');')(...Object.values(context));
}
test('mobile unlink close from the previous render uses the latest guarded view refs', async () => {
  const h = harness({ compact: true, selected: 'demo-aoi', query: 'あおい', service: 'Discord' });
  await h.link('demo-c1', 'none'); const close = capturedSheetClose(h);
  h.open(); const events = [];
  h.c.accountRows.current.set('demo-c1', { isConnected: true, focus: () => events.push('focus'), scrollIntoView: () => events.push('scroll') });
  let prevented = 0; close({ preventDefault() { prevented++; } }); h.flush();
  assert.equal(prevented, 1); assert.deepEqual(events, ['focus', 'scroll']);
  assert.equal(h.c.accountReveal.current, null); assert.equal(writes(h).length, 1);
});
for (const stale of ['epoch', 'namespace', 'navigation', 'query', 'service', 'session', 'disconnected']) {
  test(`previous-render Sheet close still rejects a newer ${stale} change`, async () => {
    const h = harness({ compact: true, selected: 'demo-aoi' });
    await h.link('demo-c1', 'none'); const close = capturedSheetClose(h); h.open(); const events = [];
    h.c.accountRows.current.set('demo-c1', { isConnected: stale !== 'disconnected', focus: () => events.push('focus'), scrollIntoView: () => events.push('scroll') });
    if (stale === 'epoch') h.c.identityEpoch.current++;
    if (stale === 'namespace') h.c.namespaceRef.current = 'synthetic-owner-B';
    if (stale === 'navigation') h.c.revealView.current.tab = 'people';
    if (stale === 'query') h.c.filtersRef.current.query = 'newer query';
    if (stale === 'service') h.c.filtersRef.current.serviceFilter = 'X';
    if (stale === 'session') h.c.sessionPending.current = true;
    close({ preventDefault() {} }); h.flush();
    assert.deepEqual(events, []); assert.equal(writes(h).length, 1);
  });
}
test('dismissal is UI-only; long names are read from records rather than saved to toast/history', async () => {
  const h = harness(); h.c.data.people.find(p => p.id === 'demo-yuki').name = '名'.repeat(100);
  await h.link('demo-c7', 'demo-yuki'); assert.equal(h.result().destination.name.length, 100);
  const accepted = structuredClone(h.c.stateRef.current), before = view(h.c);
  const noticeMarkup = source.slice(source.indexOf('  function linkResultContent('), source.indexOf('  function confirmMerge('));
  assert.match(noticeMarkup, /role="status" aria-label="アカウントの移動結果"/);
  assert.match(noticeMarkup, /linkResult\.destination\?\.name/);
  const dismiss = noticeMarkup.match(/onClick=\{(\(\) => setLinkNotice\(null\))\}/); assert.ok(dismiss);
  new Function('setLinkNotice', `return (${dismiss[1]});`)(h.c.setLinkNotice)();
  assert.equal(h.c.linkNotice, null); assert.deepEqual(view(h.c), before); assert.deepEqual(h.c.stateRef.current, accepted); assert.equal(writes(h).length, 1);
  assert.ok(writes(h)[0][2].length <= 120);
  assert.match(source.slice(source.indexOf('  function clearSessionData('), source.indexOf('  useEffect(', source.indexOf('  function clearSessionData('))), /setLinkNotice\(null\)/);
  assert.match(source, /\(!compactProfile \|\| !person\) && linkResultContent\(\)/);
  assert.match(source, /<\/SheetHeader>\{person && linkResultContent\(\)\}/);
});
