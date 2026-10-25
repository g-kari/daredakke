import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
const sourcePath = new URL('../src/app.tsx', import.meta.url);
const raw = fs.readFileSync(sourcePath, 'utf8');
const source = ts.createSourceFile('app.tsx', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let openNode, refNode, closeNode;
function visit(node) {
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'button' && node.attributes.properties.some(a => ts.isJsxAttribute(a) && a.name.text === 'className' && a.initializer?.getText(source).includes("'person-row'"))) {
    for (const a of node.attributes.properties) if (ts.isJsxAttribute(a)) {
      if (a.name.text === 'onClick') openNode = a.initializer?.expression;
      if (a.name.text === 'ref') refNode = a.initializer?.expression;
    }
  }
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'SheetContent') closeNode = node.attributes.properties.find(a => ts.isJsxAttribute(a) && a.name.text === 'onCloseAutoFocus')?.initializer?.expression;
  ts.forEachChild(node, visit);
}
visit(source);assert.ok(openNode && refNode && closeNode, 'actual row-open/ref/Sheet-close callbacks are required');
const compile = node => ts.transpileModule('const callback = (' + node.getText(source) + ');', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText + '\nreturn callback;';
const bind = (node, context) => new Function(...Object.keys(context), compile(node))(...Object.values(context));
function harness() {
  const old = { isConnected: true, focused: 0, focus() { this.focused++; } }, next = { isConnected: true, focused: 0, focus() { this.focused++; } };
  const context = { p: { id: 'synthetic-existing-person' }, profileFocus: { current: null }, identityEpoch: { current: 7 }, sessionPending: { current: false }, personDraft: null, accountDraft: null, setSelected() {}, setMergeTarget() {}, setMergeError() {}, setTab() {} };
  const open = bind(openNode, context), ref = bind(refNode, context), close = bind(closeNode, context);
  const event = { prevented: 0, preventDefault() { this.prevented++; } };
  open({ currentTarget: old });
  return { old, next, context, ref, close, event, remount() { old.isConnected = false; ref(null); ref(next); } };
}
test('ordinary existing profile close still restores its connected opener', () => { const h = harness(); h.close(h.event); assert.equal(h.old.focused, 1); assert.equal(h.event.prevented, 1); });
test('same-owner private UI remount reconnects the existing opener before Sheet close', () => { const h = harness(); h.remount(); h.close(h.event); assert.equal(h.next.focused, 1, 'the actual Sheet close callback must focus the replacement live row'); assert.equal(h.old.focused, 0); assert.equal(h.event.prevented, 1); });
test('a different person row cannot replace the ordinary opener intent', () => { const h = harness(); h.old.isConnected = false; h.ref(null); bind(refNode, { ...h.context, p: { id: 'synthetic-other-person' } })(h.next); h.close(h.event); assert.equal(h.next.focused, 0); assert.equal(h.event.prevented, 0); });
test('an identity epoch change prevents retargeting and focus', () => { const h = harness(); h.context.identityEpoch.current++; h.remount(); assert.equal(h.context.profileFocus.current.target, h.old); h.close(h.event); assert.equal(h.next.focused, 0); assert.equal(h.event.prevented, 0); });
test('pending owner verification prevents focus even when the row is live', () => { const h = harness(); h.remount(); h.context.sessionPending.current = true; h.close(h.event); assert.equal(h.next.focused, 0); assert.equal(h.event.prevented, 0); });
test('a removed opener without a replacement is never focused', () => { const h = harness(); h.old.isConnected = false; h.ref(null); h.close(h.event); assert.equal(h.old.focused, 0); assert.equal(h.next.focused, 0); assert.equal(h.event.prevented, 0); });
test('a person editor owns focus while the profile Sheet closes behind it', () => { const h = harness(); bind(closeNode, { ...h.context, personDraft: { id: 'synthetic-existing-person' } })(h.event); assert.equal(h.old.focused, 0); assert.equal(h.next.focused, 0); assert.equal(h.event.prevented, 1); });
test('an account editor owns focus while the profile Sheet closes behind it', () => { const h = harness(); bind(closeNode, { ...h.context, accountDraft: { id: 'synthetic-existing-account' } })(h.event); assert.equal(h.old.focused, 0); assert.equal(h.next.focused, 0); assert.equal(h.event.prevented, 1); });
console.log(JSON.stringify({ method: 'actual TS AST-extracted application callbacks with synthetic row objects, not rendered browser/React lifecycle verification', sourceSHA256: createHash('sha256').update(raw).digest('hex'), expected: 'same-owner remount restoration and all identity/session guards' }));
