import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { identityChanged, readNamespace, sessionChecks } from '../src/lib/session.ts';
import { readJson, ReadTimeoutError } from '../src/lib/reads.ts';
import { demoData, change } from '../src/domain/records.ts';

// Execute the actual component callbacks, not a reimplementation. Rendered UI,
// production Access and D1 are separate verification layers.
const source = ts.createSourceFile('app.tsx', fs.readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map(), effects = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') effects.push(node.arguments[0]);
  ts.forEachChild(node, visit);
}
visit(source);
const monitor = effects.find(node => node.getText(source).includes("window.addEventListener('focus'"));
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const A = 'u_' + 'a'.repeat(64), B = 'u_' + 'b'.repeat(64);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const uncertain = /保存結果を確認できませんでした/;
function harness() {
  const state = { data: demoData(), undo: [] };
  const view = { state, revision: 7, namespace: A, query: '  Synthetic  ', serviceFilter: 'Discord', tab: 'people',
    personDraft: { name: 'Unsaved person', notes: 'Unsaved note' }, accountDraft: { label: 'Unsaved account', url: '100000000000000001' },
    importText: '{"synthetic":"unsaved JSON"}', importOpen: true, importReview: { synthetic: 'review' }, notices: [] };
  const requests = [], events = new Map(), responses = [];
  const c = { ...view, scope: 'demo', busy: false,
    identityEpoch: { current: 0 }, importReadEpoch: { current: 0 }, namespaceRef: { current: A }, stateRef: { current: state },
    personDraftInitial: { current: { name: '' } }, accountDraftInitial: { current: { label: '' } },
    draftFocus: { current: { synthetic: 'focus' } }, discardFocus: { current: null }, accountReveal: { current: null },
    importConfirmationFocus: { current: null }, importSessionFocus: { current: null }, confirmationRef: { current: null },
    readRecovery: { current: null }, sessionPending: { current: false }, recordLoad: { current: null }, sessionRetry: { current: () => {} }, inputFile: { current: { value: 'synthetic.json' } },
    identityChanged, readNamespace, sessionChecks, ReadTimeoutError, AbortController, Error,
    document: { visibilityState: 'visible', addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name) },
    window: { addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name) },
    fetch: async (url, options = {}) => { requests.push({ url, ...options }); assert.ok(responses.length, 'only planned synthetic requests are allowed'); return responses.shift()(url, options); },
    toast: { error: text => view.notices.push({ kind: 'error', text }), success: text => view.notices.push({ kind: 'success', text }) },
  };
  for (const name of ['ImportConfirmationInterrupted', 'ImportReview', 'ImportSource', 'ImportFilePending', 'EmptyImportConfirmed', 'State', 'Namespace', 'Revision', 'Selected', 'PersonDraft', 'AccountDraft', 'Confirmation', 'Discard', 'ImportText', 'ImportOpen', 'ExportOpen', 'Copied', 'Query', 'ServiceFilter', 'MergeTarget', 'MergeError', 'MergeErrorPair', 'FormError', 'FormStatus', 'Error', 'CheckingSession', 'ReadFailure', 'Busy']) {
    const key = name[0].toLowerCase() + name.slice(1); c['set' + name] = value => { view[key] = value; c[key] = value; };
  }
  c.readJson = (url, signal) => readJson(url, signal, c.fetch);
  vm.createContext(c);
  vm.runInContext(compile(['clearSessionData', 'pauseConfirmationsForSession', 'requireReadRecovery', 'save', 'downloadExport', 'copyExport'].map(name => functions.get(name).getText(source)).join('\n') + '\nvar stopMonitor = (' + monitor.getText(source) + ')();'), c);
  const next = structuredClone(state.data); next.people[0].notes = 'A real synthetic edit';
  return { c, view, requests, responses, events, next: change(state, next, 'Synthetic edit'), stop: () => c.stopMonitor() };
}
function snapshot(h) { return { state: h.view.state, revision: h.view.revision, person: h.view.personDraft, account: h.view.accountDraft, json: h.view.importText, review: h.view.importReview, personInitial: h.c.personDraftInitial.current, accountInitial: h.c.accountDraftInitial.current, query: h.view.query, filter: h.view.serviceFilter }; }
function retained(h, before) {
  assert.equal(h.view.state, before.state); assert.equal(h.view.revision, before.revision);
  assert.equal(h.view.personDraft, before.person); assert.equal(h.view.accountDraft, before.account); assert.equal(h.view.importText, before.json); assert.equal(h.view.importReview, before.review);
  assert.equal(h.c.personDraftInitial.current, before.personInitial); assert.equal(h.c.accountDraftInitial.current, before.accountInitial);
  assert.equal(h.view.query, before.query); assert.equal(h.view.serviceFilter, before.filter);
}
const unreadable = [
  ['502 HTML', () => new Response('<html>upstream detail must not be echoed</html>', { status: 502 })],
  ['503 empty', () => new Response('', { status: 503 })],
  ['200 malformed JSON', () => new Response('{', { status: 200 })],
  ['200 null', () => Response.json(null)],
  ['200 missing revision', () => Response.json({})],
  ['200 invalid revision', () => Response.json({ revision: '8' })],
  ['200 array', () => Response.json([])],
];
for (const [name, response] of unreadable) test(`${name} retains inputs but gates private UI until explicit same-owner check`, async () => {
  const h = harness(), before = snapshot(h); h.responses.push(response);
  h.view.confirmation = h.c.confirmation = { run: () => { throw new Error('never replay'); } };
  h.view.discard = h.c.discard = { run: () => { throw new Error('never discard'); } };
  assert.equal(await h.c.save(h.next, 'must not report success'), false);
  retained(h, before); assert.equal(h.c.sessionPending.current, true); assert.equal(h.view.readFailure, 'save');
  assert.equal(h.view.confirmation, null); assert.equal(h.view.discard, null); assert.equal(h.view.busy, false);
  assert.match(h.view.formError, uncertain); assert.doesNotMatch(h.view.formError, /upstream detail|Unexpected|SyntaxError/);
  await h.events.get('focus')(); await h.events.get('visibilitychange')();
  assert.equal(h.requests.length, 1, 'no automatic GET or POST recovery');
  assert.equal(await h.c.save(h.next, 'blocked'), false);
  h.c.downloadExport(); await h.c.copyExport(); assert.equal(h.requests.length, 1);
  h.responses.push(() => Response.json({ namespace: A })); await h.c.sessionRetry.current();
  // sessionRetry intentionally returns void, so let its GET continuation settle.
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  retained(h, before); assert.equal(h.c.sessionPending.current, false); assert.equal(h.view.readFailure, null);
  assert.match(h.view.formError, uncertain); assert.equal(h.requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(h.requests[1].url, '/api/session'); assert.equal(h.view.notices.some(n => n.kind === 'success'), false); h.stop();
});
for (const [name, response] of [['401 HTML', () => new Response('<html>denied</html>', { status: 401 })], ['403 empty', () => new Response('', { status: 403 })], ['identity changed', () => Response.json({ code: 'identity_changed', error: 'Synthetic owner changed' }, { status: 409 })]]) test(`${name} still clears old private state and drafts`, async () => {
  const h = harness(); h.responses.push(response); assert.equal(await h.c.save(h.next, 'no'), false);
  assert.equal(h.view.state, null); assert.equal(h.view.personDraft, null); assert.equal(h.view.accountDraft, null); assert.equal(h.view.importText, ''); assert.equal(h.c.namespaceRef.current, null); assert.equal(h.c.identityEpoch.current, 1); assert.equal(h.view.readFailure, null); h.stop();
});
for (const [name, response] of [['different owner', () => Response.json({ namespace: B })], ['denied', () => new Response('', { status: 401 })], ['invalid JSON', () => new Response('{')], ['503', () => Response.json({ error: 'Unavailable' }, { status: 503 })]]) test(`explicit recovery with ${name} cannot expose retained inputs`, async () => {
  const h = harness(); h.responses.push(() => new Response('<html>unknown</html>', { status: 502 })); await h.c.save(h.next, 'no');
  h.responses.push(response); h.c.sessionRetry.current(); for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.view.state, null); assert.equal(h.view.personDraft, null); assert.equal(h.view.accountDraft, null); assert.equal(h.view.importText, ''); assert.equal(h.c.namespaceRef.current, null); assert.equal(h.requests.filter(r => r.method === 'POST').length, 1); h.stop();
});
for (const response of [() => Response.json({ error: 'Synthetic revision conflict' }, { status: 409 }), () => Response.json({ error: 'Synthetic service unavailable' }, { status: 503 })]) test(`ordinary JSON failure preserves existing retry contract (${response().status})`, async () => {
  const h = harness(), before = snapshot(h); h.responses.push(response); assert.equal(await h.c.save(h.next, 'no'), false); retained(h, before);
  assert.equal(h.c.sessionPending.current, false); assert.equal(h.view.readFailure, undefined); assert.match(h.view.formError, /Synthetic/); h.stop();
});
test('malformed reply after a committed save never automatically resends or advances revision', async () => {
  const h = harness(), before = snapshot(h); let serverRevision = 7, commits = 0;
  const server = (_url, options) => { const body = JSON.parse(options.body); if (body.revision !== serverRevision) return Response.json({ error: 'Synthetic revision conflict' }, { status: 409 }); commits++; serverRevision++; return new Response('{', { status: 200 }); };
  h.responses.push(server); await h.c.save(h.next, 'no'); retained(h, before); assert.equal(commits, 1);
  h.responses.push(() => Response.json({ namespace: A })); h.c.sessionRetry.current(); for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 2); assert.equal(h.view.revision, 7);
  h.responses.push(server); assert.equal(await h.c.save(h.next, 'no'), false);
  retained(h, before); assert.equal(commits, 1); assert.equal(h.requests.length, 3); assert.equal(JSON.parse(h.requests[2].body).revision, 7); h.stop();
});
for (const kind of ['success', 'unreadable', 'denied']) test(`late ${kind} response after owner/scope reset cannot change the new UI`, async () => {
  const h = harness(), pending = deferred(); h.responses.push(() => pending.promise); const saving = h.c.save(h.next, 'no');
  h.c.clearSessionData(); const replacement = { synthetic: 'new owner or scope' }; h.c.namespaceRef.current = B; h.view.state = replacement;
  pending.resolve(kind === 'success' ? Response.json({ revision: 8 }) : new Response('{', { status: kind === 'denied' ? 401 : 502 }));
  assert.equal(await saving, false); assert.equal(h.view.state, replacement); assert.equal(h.c.namespaceRef.current, B); assert.equal(h.view.readFailure, null); assert.equal(h.view.notices.length, 0); h.stop();
});
test('valid success publishes the intended state/revision once', async () => {
  const h = harness(); h.responses.push(() => Response.json({ revision: 8 })); assert.equal(await h.c.save(h.next, 'Synthetic saved'), true);
  assert.equal(h.view.state, h.next); assert.equal(h.view.revision, 8); assert.equal(h.requests.length, 1); assert.deepEqual(h.view.notices, [{ kind: 'success', text: 'Synthetic saved' }]); h.stop();
});
test('an older in-flight focus probe cannot lower a newer save-recovery gate', async () => {
  const h = harness(), before = snapshot(h), post = deferred(), probe = deferred();
  h.responses.push(() => post.promise); const saving = h.c.save(h.next, 'no');
  h.responses.push(() => probe.promise); const checking = h.events.get('focus')();
  post.resolve(new Response('{', { status: 502 })); await saving;
  probe.resolve(Response.json({ namespace: A })); await checking;
  retained(h, before); assert.equal(h.view.readFailure, 'save'); assert.equal(h.c.sessionPending.current, true);
  assert.equal(h.requests.length, 2); assert.equal(await h.c.save(h.next, 'blocked'), false); h.stop();
});
test('timeout during explicit recovery preserves inputs without unlocking or replaying', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(), before = snapshot(h), probe = deferred();
  h.responses.push(() => new Response('{', { status: 502 })); await h.c.save(h.next, 'no');
  h.responses.push(() => probe.promise); h.c.sessionRetry.current();
  t.mock.timers.tick(15000); for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  retained(h, before); assert.equal(h.view.readFailure, 'session'); assert.equal(h.c.sessionPending.current, true); assert.match(h.view.formError, uncertain);
  probe.resolve(Response.json({ namespace: A })); for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.view.readFailure, 'session'); assert.equal(h.c.sessionPending.current, true); assert.equal(h.requests.length, 2); h.stop();
});
test('network exceptions retain the existing non-destructive failure contract', async () => {
  const h = harness(), before = snapshot(h); h.responses.push(() => { throw new Error('Synthetic disconnected network'); });
  assert.equal(await h.c.save(h.next, 'no'), false); retained(h, before); assert.equal(h.c.sessionPending.current, false); assert.match(h.view.formError, /Synthetic disconnected network/); h.stop();
});
