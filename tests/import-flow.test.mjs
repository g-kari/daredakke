import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { demoData, empty, exportData, parseImport } from '../src/domain/records.ts';
import { buildImportReview } from '../src/domain/import-review.ts';
import { readSessionFile } from '../src/lib/session.ts';

// Execute real component callbacks; these checks do not claim rendered-browser coverage.
const source = ts.createSourceFile('app.tsx', fs.readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
function visit(node) { if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node); ts.forEachChild(node, visit); }
visit(source);
function callback(name, context) {
  const node = functions.get(name); assert.ok(node, name + ' callback exists');
  const code = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(context), code + '\nreturn ' + name + ';')(...Object.values(context));
}
const namespace = 'u_' + 'a'.repeat(64);
function harness(incoming = demoData()) {
  const original = { data: demoData(), undo: [] }, view = {}, writes = [], toasts = [];
  const context = {
    state: original, data: original.data, revision: 4, namespace, scope: 'demo', busy: false, importFilePending: false,
    importReview: null, importSource: '貼り付けたJSON', importText: exportData(incoming), emptyImportConfirmed: false,
    stateRef: { current: original }, namespaceRef: { current: namespace }, identityEpoch: { current: 2 }, importReadEpoch: { current: 5 },
    sessionPending: { current: false }, confirmationRef: { current: null }, inputFile: { current: { value: '' } }, importConfirmationFocus: { current: null }, importSessionFocus: { current: null }, discardFocus: { current: null },
    importConfirmButton: { current: null }, importReviewHeading: { current: null }, importTextInput: { current: null },
    buildImportReview, parseImport, readSessionFile,
    clearDraftFocus: () => {}, toast: { error: message => toasts.push(message) },
    requestAnimationFrame: fn => fn(),
    update: async (data, label) => { writes.push({ data, label }); return context.saveResult ?? true; },
  };
  for (const name of ['ImportConfirmationInterrupted', 'Discard', 'ImportText', 'ImportReview', 'ImportSource', 'ImportFilePending', 'EmptyImportConfirmed', 'FormError', 'ImportOpen', 'Confirmation', 'Selected']) {
    const key = name[0].toLowerCase() + name.slice(1); context['set' + name] = value => { context[key] = value; view[key] = value; if (name === 'Confirmation') context.confirmationRef.current = value; };
  }
  return { context, view, writes, toasts, original, call: (name, ...args) => callback(name, context)(...args) };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('review stages validated replacement, never writes or opens final confirmation', () => {
  const h = harness(empty()); h.call('stageImport');
  assert.equal(h.view.importReview.baseline, h.original); assert.equal(h.view.importReview.namespace, namespace);
  assert.equal(h.view.importReview.review.people.removed, 4); assert.equal(h.view.importReview.review.empty, true);
  assert.equal(h.view.confirmation, undefined); assert.deepEqual(h.writes, []);
});
for (const gate of ['busy', 'importFilePending']) test('review cannot stage while ' + gate, () => {
  const h = harness(); h.context[gate] = true; h.call('stageImport'); assert.equal(h.view.importReview, undefined); assert.deepEqual(h.writes, []);
});
test('review cannot stage while owner session is pending, absent or changed', () => {
  for (const alter of [c => c.sessionPending.current = true, c => c.namespace = null, c => c.namespaceRef.current = 'changed', c => c.state = null]) {
    const h = harness(); alter(h.context); h.call('stageImport'); assert.equal(h.view.importReview, undefined); assert.deepEqual(h.writes, []);
  }
});
test('invalid JSON clears a prior preview and acknowledgement without writes', () => {
  const h = harness(); h.call('stageImport'); h.context.importText = '{'; h.context.emptyImportConfirmed = true; h.call('stageImport');
  assert.equal(h.view.importReview, null); assert.equal(h.view.emptyImportConfirmed, false); assert.match(h.view.formError, /JSON/); assert.deepEqual(h.writes, []);
});
test('empty replacement requires acknowledgement before final confirmation', () => {
  const h = harness(empty()); h.call('stageImport'); h.call('confirmImport'); assert.equal(h.view.confirmation, undefined);
  h.context.emptyImportConfirmed = true; h.call('confirmImport'); assert.match(h.view.confirmation.message, /4人・7アカウントから、0人・0アカウント/); assert.match(h.view.confirmation.message, /記録は空になります/); assert.deepEqual(h.writes, []);
});
for (const gate of ['busy', 'importFilePending']) test('final confirmation cannot open while ' + gate, () => {
  const h = harness(); h.call('stageImport'); h.context[gate] = true; h.call('confirmImport'); assert.equal(h.view.confirmation, undefined); assert.deepEqual(h.writes, []);
});
test('final confirmation cannot open during owner verification', () => {
  const h = harness(); h.call('stageImport'); h.context.sessionPending.current = true; h.call('confirmImport'); assert.equal(h.view.confirmation, undefined);
});
const invalidate = {
  'loaded baseline': c => c.stateRef.current = { ...c.state },
  revision: c => c.revision++, namespace: c => c.namespaceRef.current = 'changed',
  'identity epoch': c => c.identityEpoch.current++, 'input epoch': c => c.importReadEpoch.current++,
};
for (const [reason, alter] of Object.entries(invalidate)) test('changed ' + reason + ' invalidates preview before final confirmation', () => {
  const h = harness(); h.call('stageImport'); alter(h.context); h.call('confirmImport');
  assert.equal(h.view.confirmation, undefined); assert.equal(h.view.importReview, null); assert.match(h.view.formError, /もう一度/); assert.deepEqual(h.writes, []);
});
for (const [reason, alter] of Object.entries(invalidate).filter(([name]) => name !== 'revision')) test('changed ' + reason + ' retires already captured final action', async () => {
  const h = harness(); h.call('stageImport'); h.call('confirmImport'); const action = h.view.confirmation.run; alter(h.context); await action(); assert.deepEqual(h.writes, []);
});
test('session verification retires captured final action until it is safe', async () => {
  const h = harness(); h.call('stageImport'); h.call('confirmImport'); h.context.sessionPending.current = true; await h.view.confirmation.run(); assert.deepEqual(h.writes, []);
});
test('ordinary save failure retains exact text and review for explicit retry', async () => {
  const h = harness(), text = h.context.importText; h.call('stageImport'); const review = h.view.importReview;
  h.context.saveResult = false; h.call('confirmImport'); await h.view.confirmation.run();
  assert.equal(h.context.importText, text); assert.equal(h.view.importReview, review); assert.equal(h.view.importOpen, undefined); assert.equal(h.writes.length, 1);
  h.context.saveResult = true; h.call('confirmImport'); await h.view.confirmation.run(); assert.equal(h.writes.length, 2); assert.equal(h.view.importReview, null); assert.equal(h.view.importOpen, false); assert.equal(h.view.importText, '');
});
test('typing invalidates review/source/acknowledgement and allows same file selection again', () => {
  const h = harness(); h.call('stageImport'); h.context.inputFile.current.value = 'C:\\fakepath\\synthetic.json'; h.context.importSource = 'synthetic.json'; h.context.importFilePending = true; h.context.emptyImportConfirmed = true;
  h.call('editImportText', 'new pasted text');
  assert.equal(h.context.inputFile.current.value, ''); assert.equal(h.view.importReview, null); assert.equal(h.view.importFilePending, false); assert.equal(h.view.emptyImportConfirmed, false); assert.equal(h.view.importSource, '貼り付けたJSON'); assert.equal(h.view.importText, 'new pasted text');
});
test('deferred file completion cannot overwrite subsequent typing or revived source', async () => {
  const h = harness(), pending = deferred(); h.context.inputFile.current.value = 'same.json';
  const reading = h.call('readFile', { size: 100, name: 'same.json', text: () => pending.promise });
  assert.equal(h.view.importFilePending, true); h.call('editImportText', 'preserved paste'); pending.resolve(exportData(empty())); await reading;
  assert.equal(h.view.importText, 'preserved paste'); assert.equal(h.view.importSource, '貼り付けたJSON'); assert.equal(h.context.inputFile.current.value, ''); assert.equal(h.view.importReview, null); assert.deepEqual(h.writes, []);
});
test('newest selected file alone may finish and label source', async () => {
  const h = harness(), a = deferred(), b = deferred();
  const first = h.call('readFile', { size: 100, name: 'old.json', text: () => a.promise });
  const second = h.call('readFile', { size: 100, name: 'new.json', text: () => b.promise });
  b.resolve(exportData(empty())); await second; const text = h.view.importText;
  a.resolve(exportData(demoData())); await first; assert.equal(h.view.importSource, 'new.json'); assert.equal(h.view.importText, text); assert.equal(h.view.importFilePending, false);
});
test('oversized or invalid files cannot leave a stale actionable preview', async () => {
  const h = harness(); h.call('stageImport');
  await h.call('readFile', { size: 900001, name: 'big.json', text: () => { throw new Error('Must not read'); } }); assert.equal(h.view.importReview, null); assert.equal(h.view.importFilePending, false);
  h.call('stageImport'); await h.call('readFile', { size: 10, name: 'invalid.json', text: async () => '{' }); assert.equal(h.view.importReview, null); assert.equal(h.view.importFilePending, false); assert.equal(h.toasts.length, 2); assert.deepEqual(h.writes, []);
});
test('review-to-edit keeps text and focuses JSON only in current identity', () => {
  const h = harness(); let focus = 0; h.context.importTextInput.current = { focus: () => focus++ }; h.call('stageImport'); const text = h.context.importText; h.call('editImportPreview');
  assert.equal(h.view.importReview, null); assert.equal(h.context.importText, text); assert.equal(focus, 1);
  h.context.sessionPending.current = true; h.call('editImportPreview'); assert.equal(focus, 1);
});
test('final cancellation restores current review button, pending save restores heading', () => {
  const h = harness(); let button = 0, heading = 0, prevented = 0;
  const target = { isConnected: true, disabled: false, focus: () => button++ };
  h.context.importConfirmButton.current = target; h.context.importReviewHeading.current = { focus: () => heading++ };
  h.call('stageImport'); h.call('confirmImport'); h.context.setConfirmation(null); h.call('restoreImportConfirmationFocus', { preventDefault: () => prevented++ }); assert.equal(button, 1); assert.equal(prevented, 1);
  h.call('confirmImport'); target.disabled = true; h.context.setConfirmation(null); h.call('restoreImportConfirmationFocus', { preventDefault: () => prevented++ }); assert.equal(heading, 1);
  h.call('confirmImport'); h.context.identityEpoch.current++; h.context.setConfirmation(null); h.call('restoreImportConfirmationFocus', { preventDefault: () => prevented++ }); assert.equal(prevented, 2);
});
test('same-owner session interruption retains focus intent and restores remounted control', () => {
  const h = harness(); let oldFocus = 0, newFocus = 0, prevented = 0;
  h.context.importConfirmButton.current = { isConnected: true, disabled: false, focus: () => oldFocus++ };
  h.call('stageImport'); h.call('confirmImport'); const intent = h.context.importConfirmationFocus.current;
  h.context.sessionPending.current = true; h.context.importConfirmButton.current = null;
  h.call('restoreImportConfirmationFocus', { preventDefault: () => prevented++ }); assert.equal(h.context.importConfirmationFocus.current, intent);
  intent.target.isConnected = false; h.context.sessionPending.current = false;
  h.context.importConfirmButton.current = { isConnected: true, disabled: false, focus: () => newFocus++ };
  h.call('restoreImportConfirmationFocus', { preventDefault: () => prevented++ }); assert.equal(h.context.importConfirmationFocus.current, intent, 'temporary cleanup after fast probe cannot consume intent while alert remains logically open');
  h.context.setConfirmation(null);
  h.call('restoreImportConfirmationFocus', { preventDefault: () => prevented++ }); assert.equal(newFocus, 1); assert.equal(oldFocus, 0); assert.equal(prevented, 1);
});
test('session verification cancels nested final confirmation while preserving current review/text', () => {
  const h = harness(); h.context.importConfirmButton.current = { isConnected: true }; h.call('stageImport'); const review = h.view.importReview, text = h.context.importText;
  h.call('confirmImport'); h.context.setDiscard({ run: () => {} }); h.context.discardFocus.current = { stale: true }; h.call('pauseConfirmationsForSession');
  assert.equal(h.view.confirmation, null); assert.equal(h.view.discard, null); assert.equal(h.context.discardFocus.current, null);
  assert.equal(h.view.importReview, review); assert.equal(h.context.importText, text); assert.equal(h.view.importConfirmationInterrupted, true);
  assert.deepEqual(h.context.importSessionFocus.current, { epoch: 2, namespace }); assert.equal(h.context.importConfirmationFocus.current, null); assert.deepEqual(h.writes, []);
});
