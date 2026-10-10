import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { personDraftChanged, accountDraftChanged } from '../src/lib/drafts.ts';

// Execute actual component callbacks with synthetic inputs. Rendered keyboard/focus
// coverage is provided by tests/browser and remains pending until hosted CI runs.
const source = ts.createSourceFile('app.tsx', fs.readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map(), effects = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') effects.push(node.arguments[0]);
  ts.forEachChild(node, visit);
}
visit(source);
function callback(node, context, name) {
  assert.ok(node, 'component callback exists');
  const code = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText.trim();
  return new Function(...Object.keys(context), name ? code + '\nreturn ' + name + ';' : 'return ' + code.replace(/;$/, '') + ';')(...Object.values(context));
}
function harness() {
  const draft = { name: 'Synthetic', aliases: '', tags: '', notes: 'Unsaved synthetic note' };
  const view = { personDraft: draft, accountDraft: null, importOpen: false, importText: '', discard: null, scope: 'demo', query: 'Synthetic' };
  const context = {
    busy: false, scope: 'demo', personDirty: true, accountDirty: false, importDirty: false, hasUnsavedChanges: true,
    identityEpoch: { current: 4 }, importReadEpoch: { current: 8 }, sessionPending: { current: false },
    personDraftInitial: { current: { name: '', aliases: '', tags: '', notes: '' } }, accountDraftInitial: { current: null }, discardFocus: { current: null },
    personDraft: draft, accountDraft: null, discard: null,
    document: { activeElement: null }, HTMLElement: class {}, personDraftChanged, accountDraftChanged,
    blankPerson: () => ({ name: '', aliases: '', tags: '', notes: '' }),
  };
  for (const name of ['PersonDraft', 'AccountDraft', 'ImportText', 'ImportOpen', 'Discard', 'Scope', 'Query', 'FormError']) {
    const key = name[0].toLowerCase() + name.slice(1);
    context['set' + name] = value => { view[key] = value; context[key] = value; };
  }
  context.requestDiscard = (...args) => callback(functions.get('requestDiscard'), context, 'requestDiscard')(...args);
  const call = (name, ...args) => callback(functions.get(name), context, name)(...args);
  return { context, view, call, draft };
}

test('dismissal keeps exact person draft until explicit discard; repeat cancellation is safe', () => {
  const h = harness();
  for (let i = 0; i < 3; i++) {
    h.call('closePersonDraft');
    assert.equal(h.view.personDraft, h.draft);
    assert.equal(h.view.discard.epoch, 4);
    h.context.setDiscard(null); // Keep Editing / Escape closes only the alert.
    assert.equal(h.view.personDraft, h.draft);
  }
  h.call('closePersonDraft'); h.call('discardChanges');
  assert.equal(h.view.personDraft, null);
  assert.equal(h.context.personDraftInitial.current, null);
  assert.equal(h.view.discard, null);
});
test('unchanged dialog closes immediately without a discard prompt', () => {
  const h = harness(); h.context.personDirty = false;
  h.call('closePersonDraft');
  assert.equal(h.view.personDraft, null); assert.equal(h.view.discard, null);
});
test('account dismissal preserves fields and only explicit discard clears them', () => {
  const h = harness(); const draft = { service: 'X', label: 'Synthetic', url: 'invalid input', personId: 'none' };
  h.context.accountDirty = true; h.context.setAccountDraft(draft); h.context.accountDraftInitial.current = { ...draft, url: '' };
  h.call('closeAccountDraft'); assert.equal(h.view.accountDraft, draft);
  h.call('discardChanges'); assert.equal(h.view.accountDraft, null); assert.equal(h.context.accountDraftInitial.current, null);
});
test('import dismissal preserves staged JSON and invalidates pending reads only after discard', () => {
  const h = harness(); h.context.importDirty = true; h.context.setImportOpen(true); h.context.setImportText('{"synthetic":true}');
  h.call('closeImport');
  assert.equal(h.view.importOpen, true); assert.equal(h.view.importText, '{"synthetic":true}'); assert.equal(h.context.importReadEpoch.current, 8);
  h.context.setDiscard(null); h.call('closeImport'); h.call('discardChanges');
  assert.equal(h.view.importOpen, false); assert.equal(h.view.importText, ''); assert.equal(h.context.importReadEpoch.current, 9);
});
test('scope switching waits for discard; same scope is a no-op', () => {
  const h = harness(); h.call('switchScope', 'demo'); assert.equal(h.view.discard, null);
  h.call('switchScope', 'personal'); assert.equal(h.view.scope, 'demo'); assert.equal(h.view.query, 'Synthetic');
  h.context.setDiscard(null); h.call('switchScope', 'personal'); h.call('discardChanges');
  assert.equal(h.view.scope, 'personal'); assert.equal(h.view.query, '');
});
test('busy or pending-session state blocks both close and scope actions', () => {
  for (const gate of ['busy', 'session']) {
    const h = harness(); h.context.personDirty = false;
    if (gate === 'busy') h.context.busy = true; else h.context.sessionPending.current = true;
    h.call('closePersonDraft'); h.call('switchScope', 'personal');
    assert.equal(h.view.personDraft, h.draft); assert.equal(h.view.scope, 'demo'); assert.equal(h.view.discard, null);
  }
});
test('old discard action cannot apply after an identity reset or while verification is pending', () => {
  for (const transition of ['identity', 'session']) {
    const h = harness(); h.call('closePersonDraft');
    if (transition === 'identity') h.context.identityEpoch.current++; else h.context.sessionPending.current = true;
    h.call('discardChanges');
    assert.equal(h.view.personDraft, h.draft); assert.equal(h.view.discard, null);
  }
});
test('opening person creation again protects the existing draft instead of overwriting it', () => {
  const h = harness(); h.call('editPerson');
  assert.equal(h.view.personDraft, h.draft);
  h.call('discardChanges'); assert.deepEqual(h.view.personDraft, { name: '', aliases: '', tags: '', notes: '' });
});
test('browser navigation warning is attached only while unsaved changes exist and is cleaned up', () => {
  const effect = effects.find(node => node.getText(source).includes("'beforeunload'"));
  const listeners = new Map();
  const window = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  assert.equal(callback(effect, { hasUnsavedChanges: false, window })(), undefined); assert.equal(listeners.size, 0);
  const stop = callback(effect, { hasUnsavedChanges: true, window })();
  const event = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
  listeners.get('beforeunload')(event); assert.equal(event.prevented, true); assert.equal(event.returnValue, '');
  stop(); assert.equal(listeners.size, 0);
});

test('repeat requests coalesce while discard alert is open and retain the original focus', () => {
  const h = harness();
  const input = new h.context.HTMLElement();
  const alertButton = new h.context.HTMLElement();
  h.context.document.activeElement = input;
  h.call('closePersonDraft');
  const first = h.view.discard;
  h.context.document.activeElement = alertButton;
  h.call('editPerson'); h.call('closePersonDraft'); h.call('switchScope', 'personal');
  assert.equal(h.view.discard, first);
  assert.equal(h.context.discardFocus.current, input);
  h.context.setDiscard(null); h.call('closePersonDraft'); h.call('discardChanges');
  assert.equal(h.view.personDraft, null);
});
