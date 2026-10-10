import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { readNamespace, readSessionFile, verifyLoadedNamespace, sessionChecks } from '../src/lib/session.ts';
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
    scope: 'demo', namespace,
    identityEpoch: { current: 0 }, importReadEpoch: { current: 0 },
    personDraftInitial: { current: null }, accountDraftInitial: { current: null }, draftFocus: { current: null }, discardFocus: { current: null },
    namespaceRef: { current: namespace }, stateRef: { current: null },
    sessionPending: { current: false }, recordLoad: { current: null },
    inputFile: { current: { value: '' } },
    readNamespace, readSessionFile, verifyLoadedNamespace, sessionChecks, parseImport,
    window: { addEventListener: (name, fn) => windowEvents.set(name, fn), removeEventListener: name => windowEvents.delete(name) },
    document: { visibilityState: 'visible', addEventListener: (name, fn) => documentEvents.set(name, fn), removeEventListener: name => documentEvents.delete(name) },
    fetch: (url, options) => { const pending = deferred(); requests.push({ url, options, ...pending }); return pending.promise; },
    toast: { error: () => { view.toasts = (view.toasts ?? 0) + 1; } },
  };
  for (const name of ['State', 'Namespace', 'Revision', 'Selected', 'PersonDraft', 'AccountDraft', 'Confirmation', 'Discard', 'ImportText', 'ImportOpen', 'ExportOpen', 'Copied', 'Query', 'ServiceFilter', 'MergeTarget', 'FormError', 'Error', 'CheckingSession']) {
    const key = name[0].toLowerCase() + name.slice(1);
    context['set' + name] = value => { view[key] = value; };
  }
  context.clearSessionData = callback(functions.get('clearSessionData'), context, 'clearSessionData');
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
