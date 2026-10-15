import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { identityChanged, readNamespace, readSessionFile, verifyLoadedNamespace, sessionChecks } from '../src/lib/session.ts';
import { readJson, ReadTimeoutError, READ_TIMEOUT_MS } from '../src/lib/reads.ts';
import { demoData, exportData, parseImport } from '../src/domain/records.ts';

// Exercise the actual component callbacks without claiming rendered-browser coverage.
const source = ts.createSourceFile('app.tsx', fs.readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects = [], functions = new Map();
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') effects.push(node.arguments[0]);
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  ts.forEachChild(node, visit);
}
visit(source);
function callback(node, context, name) {
  assert.ok(node, 'component callback exists');
  const code = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText.trim();
  const body = name ? code + '\nreturn ' + name + ';' : 'return ' + code.replace(/;$/, '') + ';';
  return new Function(...Object.keys(context), body)(...Object.values(context));
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); }
const A = 'u_' + 'a'.repeat(64), B = 'u_' + 'b'.repeat(64);
function harness(namespace = null) {
  const view = { state: null, importText: '', importOpen: false, checkingSession: false };
  const windowEvents = new Map(), documentEvents = new Map(), requests = [];
  const context = {
    scope: 'demo', namespace, busy: false, revision: 0,
    identityEpoch: { current: 0 }, importReadEpoch: { current: 0 }, importConfirmationFocus: { current: null }, importSessionFocus: { current: null },
    personDraftInitial: { current: null }, accountDraftInitial: { current: null }, draftFocus: { current: null }, discardFocus: { current: null },
    namespaceRef: { current: namespace }, stateRef: { current: null },
    sessionPending: { current: false }, recordLoad: { current: null }, readRecovery: { current: null }, sessionRetry: { current: () => {} },
    inputFile: { current: { value: '' } },
    identityChanged, readNamespace, readSessionFile, verifyLoadedNamespace, sessionChecks, parseImport, ReadTimeoutError,
    window: { addEventListener: (name, fn) => windowEvents.set(name, fn), removeEventListener: name => windowEvents.delete(name) },
    document: { visibilityState: 'visible', addEventListener: (name, fn) => documentEvents.set(name, fn), removeEventListener: name => documentEvents.delete(name) },
    fetch: (url, options) => { const pending = deferred(); requests.push({ url, options, ...pending }); return pending.promise; },
    toast: { success: () => {}, error: () => { view.toasts = (view.toasts ?? 0) + 1; } },
  };
  for (const name of ['ImportConfirmationInterrupted', 'ImportReview', 'ImportSource', 'ImportFilePending', 'EmptyImportConfirmed', 'State', 'Namespace', 'Revision', 'Selected', 'PersonDraft', 'AccountDraft', 'Confirmation', 'Discard', 'ImportText', 'ImportOpen', 'ExportOpen', 'Copied', 'Query', 'ServiceFilter', 'MergeTarget', 'FormError', 'Error', 'CheckingSession', 'ReadFailure', 'Busy']) {
    const key = name[0].toLowerCase() + name.slice(1);
    context['set' + name] = value => { view[key] = value; };
  }
  context.readJson = (url, signal, _fetcher, failureMessage) => readJson(url, signal, context.fetch, failureMessage);
  context.requireReadRecovery = callback(functions.get('requireReadRecovery'), context, 'requireReadRecovery');
  context.clearSessionData = callback(functions.get('clearSessionData'), context, 'clearSessionData');
  context.pauseConfirmationsForSession = callback(functions.get('pauseConfirmationsForSession'), context, 'pauseConfirmationsForSession');
  return { context, view, windowEvents, documentEvents, requests };
}
const loadNode = effects.find(node => node.getText(source).includes("'/api/records?scope='"));
const monitorNode = effects.find(node => node.getText(source).includes("window.addEventListener('focus'"));

test('actual pending record callback cannot publish A after focus switches to B during initial load', async () => {
  const h = harness();
  const stopLoad = callback(loadNode, h.context)();
  const stopMonitor = callback(monitorNode, h.context)();
  assert.equal(h.requests[0].url, '/api/records?scope=demo');
  const focus = h.windowEvents.get('focus')();
  assert.equal(h.requests[0].options.signal.aborted, true, 'focus retires the pending record load');
  assert.equal(h.requests[1].url, '/api/session', 'focus must not skip a loading namespace');
  assert.equal(h.view.checkingSession, true);
  h.requests[1].resolve(Response.json({ namespace: B }));
  await focus;
  h.requests[0].resolve(Response.json({ namespace: A, revision: 0, state: { data: demoData(), undo: [] } }));
  await flush();
  assert.equal(h.view.state, null);
  assert.equal(h.context.namespaceRef.current, null);
  assert.match(h.view.error, /再読み込み/);
  stopMonitor(); stopLoad();
});

test('actual record callback verifies current session before showing a completed old-identity response', async () => {
  const h = harness();
  const stop = callback(loadNode, h.context)();
  h.requests[0].resolve(Response.json({ namespace: A, revision: 0, state: { data: demoData(), undo: [] } }));
  await flush();
  assert.equal(h.requests[1].url, '/api/session');
  assert.equal(h.view.state, null, 'record is hidden until session confirmation');
  h.requests[1].resolve(Response.json({ namespace: B }));
  await flush();
  assert.equal(h.view.state, null);
  assert.equal(h.context.namespaceRef.current, null);
  assert.match(h.view.error, /変わりました/);
  stop();
});

test('actual overlapping focus probes supersede old responses and keep the private UI gated', async () => {
  const h = harness(A);
  h.view.state = { syntheticNote: 'A-only' };
  h.view.personDraft = { notes: 'A-only draft' };
  h.context.personDraftInitial.current = { notes: 'A-only original' };
  h.context.accountDraftInitial.current = { label: 'A-only account' };
  h.context.discardFocus.current = { id: 'A-only input' };
  h.view.discard = { epoch: 0, run: () => { throw new Error('Old discard must never execute'); } };
  const stop = callback(monitorNode, h.context)();
  const first = h.windowEvents.get('focus')();
  const second = h.documentEvents.get('visibilitychange')();
  assert.equal(h.requests.length, 2, 'new event is not dropped');
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.context.sessionPending.current, true);
  assert.equal(h.view.checkingSession, true);
  h.requests[0].resolve(Response.json({ namespace: A }));
  await first;
  assert.equal(h.view.checkingSession, true, 'late A confirmation cannot lower the newer verification veil');
  h.requests[1].resolve(Response.json({ namespace: B }));
  await second;
  assert.equal(h.view.state, null);
  assert.equal(h.view.personDraft, null);
  assert.equal(h.context.personDraftInitial.current, null);
  assert.equal(h.context.accountDraftInitial.current, null);
  assert.equal(h.context.discardFocus.current, null);
  assert.equal(h.view.discard, null);
  assert.equal(h.context.sessionPending.current, false);
  assert.equal(h.view.checkingSession, false);
  stop();
});

test('actual deferred file callback cannot resurrect import text, dialog, toast or file input after B load or scope switch', async () => {
  for (const transition of ['identity', 'scope']) {
    const h = harness(A), pending = deferred();
    const readFile = callback(functions.get('readFile'), h.context, 'readFile');
    const reading = readFile({ size: 50, text: () => pending.promise });
    h.context.clearSessionData();
    h.context.namespaceRef.current = transition === 'identity' ? B : A;
    h.view.state = { syntheticNote: transition === 'identity' ? 'B-only' : 'new-scope' };
    h.context.inputFile.current.value = 'new-session-file';
    pending.resolve(exportData(demoData()));
    await reading;
    assert.equal(h.view.importText, '');
    assert.equal(h.view.importOpen, false);
    assert.equal(h.view.toasts ?? 0, 0);
    assert.equal(h.context.inputFile.current.value, 'new-session-file');
  }
});
test('actual matching record and focus checks load data and preserve same-session drafts', async () => {
  const h = harness(), data = demoData();
  const stopLoad = callback(loadNode, h.context)();
  h.requests[0].resolve(Response.json({ namespace: A, revision: 3, state: { data, undo: [] } }));
  await flush();
  h.requests[1].resolve(Response.json({ namespace: A }));
  await flush();
  assert.deepEqual(h.view.state, { data, undo: [] });
  assert.equal(h.view.revision, 3);
  assert.equal(h.context.namespaceRef.current, A);
  h.view.personDraft = { notes: 'same-session draft' };
  const stopMonitor = callback(monitorNode, h.context)();
  const focus = h.windowEvents.get('focus')();
  assert.equal(h.view.checkingSession, true);
  h.requests[2].resolve(Response.json({ namespace: A }));
  await focus;
  assert.equal(h.view.checkingSession, false);
  assert.deepEqual(h.view.personDraft, { notes: 'same-session draft' });
  assert.deepEqual(h.view.state, { data, undo: [] });
  stopMonitor(); stopLoad();
});
test('actual pending-session export callbacks do not transmit records to download or clipboard', async () => {
  const h = harness(A);
  h.context.sessionPending.current = true;
  h.context.navigator = { clipboard: { writeText: () => { throw new Error('unexpected clipboard write'); } } };
  callback(functions.get('downloadExport'), h.context, 'downloadExport')();
  await callback(functions.get('copyExport'), h.context, 'copyExport')();
  assert.equal(h.view.copied, undefined);
});

for (const stage of ['records-fetch', 'records-body', 'session-fetch', 'session-body']) test(`initial ${stage} deadline exposes only explicit recovery and fences late results`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(), body = deferred(), data = demoData();
  const stop = callback(loadNode, h.context)();
  const records = { namespace: A, revision: 3, state: { data, undo: [] } };
  if (stage !== 'records-fetch') {
    h.requests[0].resolve(stage === 'records-body' ? { ok: true, json: () => body.promise } : Response.json(records)); await flush();
  }
  if (stage === 'session-body') { h.requests[1].resolve({ ok: true, json: () => body.promise }); await flush(); }
  const count = h.requests.length;
  t.mock.timers.tick(READ_TIMEOUT_MS); await flush();
  assert.equal(h.view.readFailure, 'load'); assert.equal(h.view.state, null); assert.equal(h.context.namespaceRef.current, null);
  assert.equal(h.context.sessionPending.current, true); assert.equal(h.view.checkingSession, false);
  if (stage === 'records-fetch') h.requests[0].resolve(Response.json(records));
  if (stage === 'session-fetch') h.requests[1].resolve(Response.json({ namespace: A }));
  body.resolve(stage === 'records-body' ? records : { namespace: A }); await flush();
  assert.equal(h.view.state, null); assert.equal(h.view.readFailure, 'load'); assert.equal(h.requests.length, count);
  t.mock.timers.tick(READ_TIMEOUT_MS * 3); await flush(); assert.equal(h.requests.length, count);
  stop();
});
function retainDrafts(h) {
  h.view.state = { data: demoData(), undo: [] }; h.context.stateRef.current = h.view.state;
  h.view.personDraft = { name: 'Synthetic person', aliases: 'Alias', tags: 'Tag', notes: 'Unsaved person' };
  h.view.accountDraft = { service: 'X', url: 'synthetic', label: 'Unsaved account', personId: 'none' };
  h.view.importText = '{"synthetic":"unsaved JSON"}'; h.view.importOpen = true;
  h.context.personDraftInitial.current = { name: '' }; h.context.accountDraftInitial.current = { url: '' };
  return { state: h.view.state, person: h.view.personDraft, account: h.view.accountDraft, json: h.view.importText };
}
for (const stage of ['fetch', 'body']) test(`focus ${stage} deadline preserves all drafts but stays gated until explicit same-owner retry`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(A), drafts = retainDrafts(h), body = deferred();
  h.view.confirmation = { action: 'never replay' }; h.view.discard = { action: 'never discard' };
  const stop = callback(monitorNode, h.context)(); const focus = h.windowEvents.get('focus')();
  if (stage === 'body') { h.requests[0].resolve({ ok: true, json: () => body.promise }); await flush(); }
  t.mock.timers.tick(READ_TIMEOUT_MS); await focus;
  assert.equal(h.view.readFailure, 'session'); assert.equal(h.context.sessionPending.current, true); assert.equal(h.view.checkingSession, false);
  assert.equal(h.view.state, drafts.state); assert.equal(h.view.personDraft, drafts.person); assert.equal(h.view.accountDraft, drafts.account); assert.equal(h.view.importText, drafts.json);
  assert.equal(h.view.confirmation, null); assert.equal(h.view.discard, null);
  await h.windowEvents.get('focus')(); await h.documentEvents.get('visibilitychange')(); t.mock.timers.tick(READ_TIMEOUT_MS * 3);
  assert.equal(h.requests.length, 1, 'events and elapsed time cannot auto-retry recovery');
  callback(functions.get('downloadExport'), h.context, 'downloadExport')(); await callback(functions.get('copyExport'), h.context, 'copyExport')();
  assert.equal(await callback(functions.get('save'), h.context, 'save')(drafts.state, 'unexpected'), false);
  h.context.sessionRetry.current(); assert.equal(h.requests.length, 2); assert.equal(h.view.checkingSession, true);
  h.requests[1].resolve(Response.json({ namespace: A })); await flush();
  assert.equal(h.context.sessionPending.current, false); assert.equal(h.view.readFailure, null);
  assert.equal(h.view.personDraft, drafts.person); assert.equal(h.view.accountDraft, drafts.account); assert.equal(h.view.importText, drafts.json);
  assert.equal(h.view.confirmation, null); assert.equal(h.view.discard, null);
  h.requests[0].resolve(Response.json({ namespace: B })); body.resolve({ namespace: B }); await flush();
  assert.equal(h.context.namespaceRef.current, A); assert.equal(h.view.state, drafts.state); stop();
});
for (const rejection of ['different-owner', '401', '403', '503', 'malformed', 'network']) test(`explicit recovery clears every draft on ${rejection} rejection`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(A); retainDrafts(h);
  const stop = callback(monitorNode, h.context)(); const first = h.windowEvents.get('focus')();
  t.mock.timers.tick(READ_TIMEOUT_MS); await first; h.context.sessionRetry.current();
  if (rejection === 'network') h.requests[1].resolve(Promise.reject(new TypeError('synthetic network error')));
  else if (rejection === 'malformed') h.requests[1].resolve(Response.json({ namespace: 'invalid' }));
  else h.requests[1].resolve(Response.json({ namespace: rejection === 'different-owner' ? B : A }, { status: Number(rejection) || 200 }));
  await flush();
  assert.equal(h.view.state, null); assert.equal(h.view.personDraft, null); assert.equal(h.view.accountDraft, null); assert.equal(h.view.importText, '');
  assert.equal(h.context.namespaceRef.current, null); assert.equal(h.view.readFailure, null); assert.match(h.view.error, /ログイン/); stop();
});
test('a newer retry/event owns the gate even when an older deadline or successful body finishes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(A); retainDrafts(h); const body = deferred(); const stop = callback(monitorNode, h.context)();
  const old = h.windowEvents.get('focus')(); h.requests[0].resolve({ ok: true, json: () => body.promise }); await flush();
  t.mock.timers.tick(READ_TIMEOUT_MS - 1); const newer = h.documentEvents.get('visibilitychange')(); await old;
  t.mock.timers.tick(1); await flush(); assert.equal(h.view.checkingSession, true); assert.equal(h.view.readFailure, null);
  body.resolve({ namespace: B }); await flush(); assert.equal(h.context.namespaceRef.current, A); assert.equal(h.view.checkingSession, true);
  t.mock.timers.tick(READ_TIMEOUT_MS - 1); await newer; assert.equal(h.view.readFailure, 'session');
  h.context.sessionRetry.current(); const latest = h.windowEvents.get('focus')();
  assert.equal(h.requests[2].options.signal.aborted, true);
  h.requests[2].resolve(Response.json({ namespace: A })); await flush(); assert.equal(h.view.checkingSession, true);
  h.requests[3].resolve(Response.json({ namespace: A })); await latest;
  assert.equal(h.view.checkingSession, false); assert.equal(h.view.readFailure, null); stop();
});
test('scope reload and unmount cancel stale read deadlines and late bodies silently', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(), body = deferred(); const stopFirst = callback(loadNode, h.context)();
  h.requests[0].resolve({ ok: true, json: () => body.promise }); await flush(); stopFirst();
  h.context.scope = 'personal'; const stopSecond = callback(loadNode, h.context)();
  assert.equal(h.requests[0].options.signal.aborted, true);
  body.resolve({ namespace: A, revision: 0, state: { data: demoData(), undo: [] } }); await flush();
  assert.equal(h.requests.length, 2); assert.equal(h.view.state, null); assert.equal(h.view.readFailure, null);
  stopSecond(); t.mock.timers.tick(READ_TIMEOUT_MS * 2); await flush();
  assert.equal(h.view.readFailure, null); assert.equal(h.view.error, '');
  const active = harness(A); retainDrafts(active); const stopMonitor = callback(monitorNode, active.context)();
  const focus = active.windowEvents.get('focus')(); stopMonitor(); await focus;
  t.mock.timers.tick(READ_TIMEOUT_MS * 2); active.requests[0].resolve(Response.json({ namespace: B })); await flush();
  assert.equal(active.context.namespaceRef.current, A); assert.equal(active.view.readFailure, null); assert.equal(active.windowEvents.size, 0);
});
test('an already sent POST can settle during recovery without clearing the verification gate or replaying writes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(A), drafts = retainDrafts(h); h.context.state = drafts.state;
  const next = { ...drafts.state, undo: [{ synthetic: true }] };
  const saving = callback(functions.get('save'), h.context, 'save')(next, 'Synthetic save');
  assert.equal(h.requests[0].options.method, 'POST');
  const stop = callback(monitorNode, h.context)(), checking = h.windowEvents.get('focus')();
  t.mock.timers.tick(READ_TIMEOUT_MS); await checking;
  assert.equal(h.requests[0].options.signal, undefined, 'writes do not acquire the GET deadline');
  assert.equal(h.context.sessionPending.current, true); assert.equal(h.view.readFailure, 'session');
  h.requests[0].resolve(Response.json({ revision: 1 })); assert.equal(await saving, true);
  assert.equal(h.context.sessionPending.current, true); assert.equal(h.view.readFailure, 'session'); assert.equal(h.view.checkingSession, false);
  assert.equal(h.view.state, next); assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 1);
  t.mock.timers.tick(READ_TIMEOUT_MS * 2); assert.equal(h.requests.length, 2); stop();
});
for (const outcome of ['same-owner', 'rejected-owner']) test(`a stalled POST does not block an explicit ${outcome} recovery GET or bypass its gate`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(A), drafts = retainDrafts(h); h.context.state = drafts.state;
  const next = { ...drafts.state, undo: [{ synthetic: true }] };
  const saving = callback(functions.get('save'), h.context, 'save')(next, 'Synthetic save');
  const stop = callback(monitorNode, h.context)(), checking = h.windowEvents.get('focus')();
  t.mock.timers.tick(READ_TIMEOUT_MS); await checking;
  h.context.busy = true; assert.equal(h.view.busy, true);
  h.context.sessionRetry.current(); assert.equal(h.requests.length, 3, 'safe identity GET is allowed while the earlier POST is unresolved');
  h.requests[2].resolve(Response.json({ namespace: outcome === 'same-owner' ? A : B })); await flush();
  if (outcome === 'same-owner') {
    assert.equal(h.context.namespaceRef.current, A); assert.equal(h.view.personDraft, drafts.person);
  } else { assert.equal(h.context.namespaceRef.current, null); assert.equal(h.view.personDraft, null); }
  h.requests[0].resolve(Response.json({ revision: 1 })); assert.equal(await saving, outcome === 'same-owner');
  assert.equal(h.view.state, outcome === 'same-owner' ? next : null);
  assert.equal(h.view.readFailure, null); assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 1); stop();
});
test('recovery UI leaves the read-only retry available while a prior POST is busy', () => {
  const branch = source.text.slice(source.text.indexOf('  if (readFailure) return'), source.text.indexOf('  if (checkingSession) return'));
  assert.match(branch, /sessionRetry.current\(\)/);
  assert.doesNotMatch(branch, /disabled=\{busy\}/);
});
test('an actual records rejection retains the read failure message without waiting on an error body', async () => {
  const h = harness(); const stop = callback(loadNode, h.context)();
  h.requests[0].resolve({ ok: false, status: 503, json: () => { throw new Error('error body must not be read'); } }); await flush();
  assert.equal(h.view.state, null); assert.match(h.view.error, /保存データを読み込めませんでした/); assert.equal(h.view.readFailure, null); stop();
});
