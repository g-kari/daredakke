import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// Exercise the actual React callback without a browser or a record/API write.
const source = ts.createSourceFile('app.tsx', fs.readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler, alertContent;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'keepEditingOnEscape') handler = node;
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'AlertDialogContent' && node.attributes.properties.some(p => p.name?.getText(source) === 'onCloseAutoFocus' && p.initializer?.getText(source) === '{restoreDiscardFocus}')) alertContent = node;
  ts.forEachChild(node, visit);
}
visit(source);
function callback(setDiscard) {
  assert.ok(handler, 'the actual scoped Escape handler exists');
  const code = ts.transpileModule(handler.getText(source) + '\nreturn keepEditingOnEscape;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function('setDiscard', code)(setDiscard);
}
test('the discard content captures Escape and preserves guarded close-focus restoration', () => {
  assert.ok(alertContent);
  assert.ok(alertContent.attributes.properties.some(p => p.name?.getText(source) === 'onKeyDownCapture' && p.initializer?.getText(source) === '{keepEditingOnEscape}'));
  assert.ok(alertContent.attributes.properties.some(p => p.name?.getText(source) === 'onCloseAutoFocus' && p.initializer?.getText(source) === '{restoreDiscardFocus}'));
});
test('Escape cancels only the pending alert, prevents default and stops propagation', () => {
  const calls = [];
  const run = callback(value => calls.push(['discard', value]));
  for (let i = 0; i < 5; i++) run({ key: 'Escape', preventDefault: () => calls.push(['prevent']), stopPropagation: () => calls.push(['stop']) });
  assert.deepEqual(calls, Array.from({ length: 5 }, () => [['prevent'], ['stop'], ['discard', null]]).flat());
});
test('non-Escape keys keep the alert and ordinary keyboard behavior untouched', () => {
  const calls = [], run = callback(value => calls.push(value));
  for (const key of ['Enter', 'Tab', ' ', 'ArrowLeft', 'a']) run({ key, preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop') });
  assert.deepEqual(calls, []);
});
