import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { demoData, validateData, mergePeople } from '../src/domain/records.ts';
const fixture = () => { const data = demoData(); data.people[0].aliases = []; data.people[3].aliases = []; return data; };
const source = ts.createSourceFile('app.tsx', fs.readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'confirmMerge') handler = node; ts.forEachChild(node, visit); } visit(source);
function harness(data) {
  const errors = [], confirmations = [], updates = [];
  const context = { data, mergePeople, toast: { error: message => errors.push(message) }, setConfirmation: value => confirmations.push(value), update: async (next, label) => { updates.push({ next, label }); return true; }, setSelected() {}, setMergeTarget() {} };
  const code = ts.transpileModule(handler.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return { errors, confirmations, updates, run: new Function(...Object.keys(context), code + '\nreturn confirmMerge;')(...Object.values(context)) };
}
for (const length of [80, 81, 100]) test(`source name length ${length} is checked before confirmation without mutation`, async () => {
  const data = fixture(); data.people[3].name = '名'.repeat(length); validateData(data);
  const before = structuredClone(data), h = harness(data); h.run('demo-aoi', 'demo-ao');
  assert.deepEqual(data, before); assert.equal(h.updates.length, 0);
  if (length === 80) { assert.equal(h.errors.length, 0); assert.equal(h.confirmations.length, 1); await h.confirmations[0].run(); assert.equal(h.updates.length, 1); assert.ok(h.updates[0].next.people[0].aliases.includes('名'.repeat(length))); }
  else { assert.equal(h.confirmations.length, 0); assert.match(h.errors[0], /80文字.*名前を短く/); assert.throws(() => mergePeople(data, 'demo-aoi', 'demo-ao'), /80文字/); }
  assert.deepEqual(data, before);
});
for (const [field, prepare, expected] of [
  ['aliases', data => { data.people[0].aliases = Array.from({ length: 20 }, (_, i) => `alias${i}`); }, /別名が20個/],
  ['tags', data => { data.people[0].tags = Array.from({ length: 20 }, (_, i) => `tag${i}`); data.people[3].tags = ['additional']; }, /タグが20個/],
  ['notes', data => { data.people[0].notes = 'a'.repeat(3000); data.people[3].notes = 'b'.repeat(2999); }, /メモが6,000文字/],
]) test(`${field} overflow is actionable before confirmation`, () => {
  const data = fixture(); prepare(data); validateData(data); const before = structuredClone(data), h = harness(data);
  h.run('demo-aoi', 'demo-ao'); assert.equal(h.confirmations.length, 0); assert.equal(h.updates.length, 0); assert.match(h.errors[0], expected); assert.deepEqual(data, before);
});
test('duplicates are removed before the alias and tag limits are checked', () => {
  const data = fixture(); const values = Array.from({ length: 20 }, (_, i) => `alias${i}`);
  data.people[0].aliases = values; data.people[3].aliases = [...values]; data.people[3].name = values[0];
  data.people[0].tags = values; data.people[3].tags = [...values];
  const next = mergePeople(validateData(data), 'demo-aoi', 'demo-ao'); assert.deepEqual(next.people[0].aliases, values); assert.deepEqual(next.people[0].tags, values);
});
test('identical long names do not become aliases and retain the existing valid merge behavior', () => {
  const data = fixture(); data.people[0].name = data.people[3].name = '名'.repeat(100);
  assert.equal(mergePeople(validateData(data), 'demo-aoi', 'demo-ao').people[0].name.length, 100);
});
test('6000 character combined notes including separator remain valid', () => {
  const data = fixture(); data.people[0].notes = 'a'.repeat(3000); data.people[3].notes = 'b'.repeat(2998);
  assert.equal(mergePeople(validateData(data), 'demo-aoi', 'demo-ao').people[0].notes.length, 6000);
});
test('confirmation rechecks current data and cannot save a later invalid merge', async () => {
  const data = fixture(), h = harness(data); h.run('demo-aoi', 'demo-ao'); assert.equal(h.confirmations.length, 1);
  data.people[3].name = '名'.repeat(81); await h.confirmations[0].run(); assert.equal(h.updates.length, 0); assert.match(h.errors[0], /80文字/);
});
