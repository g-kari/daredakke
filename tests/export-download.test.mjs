import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { demoData, exportData, parseImport } from '../src/domain/records.ts';
const source = ts.createSourceFile('app.tsx', fs.readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let node;
function visit(n) { if (ts.isFunctionDeclaration(n) && n.name?.text === 'downloadExport') node = n; ts.forEachChild(n, visit); }
visit(source); assert.ok(node);
const code = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(failure) {
  const events = [], timers = [], data = demoData(), namespace = 'synthetic';
  const context = {
    sessionPending: { current: false }, namespace, namespaceRef: { current: namespace }, data, exportData: value => { if (failure === 'serialize') throw Error('PRIVATE synthetic detail'); return exportData(value); }, Blob, scope: 'demo',
    URL: { createObjectURL(blob) { events.push(['allocate', blob]); if (failure === 'allocate') throw Error('PRIVATE synthetic detail'); return 'blob:synthetic'; }, revokeObjectURL(url) { events.push(['revoke', url]); } },
    document: { createElement(tag) { assert.equal(tag, 'a'); if (failure === 'element') throw Error('PRIVATE synthetic detail'); const a = { click() { events.push(['click', a.href, a.download]); if (failure === 'click') throw Error('PRIVATE synthetic detail'); } }; return a; } },
    setTimeout(fn, ms) { assert.equal(ms, 1000); timers.push(fn); },
    toast: { success(text) { events.push(['success', text]); }, error(text) { events.push(['error', text]); } },
  };
  const run = new Function(...Object.keys(context), code + '\nreturn downloadExport;')(...Object.values(context));
  return { run, context, events, timers, data, recover() { failure = undefined; } };
}
for (const failure of ['serialize', 'allocate', 'element', 'click']) test(`download ${failure} failure is recoverable and cleans any allocated URL`, async () => {
  const h = harness(failure), before = structuredClone(h.data);
  assert.doesNotThrow(h.run);
  assert.equal(h.events.filter(e => e[0] === 'success').length, 0);
  const errors = h.events.filter(e => e[0] === 'error'); assert.equal(errors.length, 1); assert.match(errors[0][1], /JSONをコピー/); assert.doesNotMatch(errors[0][1], /PRIVATE/);
  assert.deepEqual(h.data, before);
  assert.equal(h.timers.length, ['serialize', 'allocate'].includes(failure) ? 0 : 1); h.timers.forEach(fn => fn());
  assert.equal(h.events.filter(e => e[0] === 'revoke').length, ['serialize', 'allocate'].includes(failure) ? 0 : 1);
});
test('successful download preserves export format, reports initiation, and revokes once', async () => {
  const h = harness(); h.run();
  const blob = h.events.find(e => e[0] === 'allocate')[1]; assert.equal(blob.type, 'application/json');
  assert.deepEqual(parseImport(await blob.text()), h.data);
  const click = h.events.find(e => e[0] === 'click'); assert.equal(click[1], 'blob:synthetic'); assert.match(click[2], /^daredakke-demo-\d{4}-\d{2}-\d{2}\.json$/);
  assert.match(h.events.find(e => e[0] === 'success')[1], /開始/); assert.equal(h.events.filter(e => e[0] === 'error').length, 0);
  assert.equal(h.timers.length, 1); h.timers[0](); assert.deepEqual(h.events.at(-1), ['revoke', 'blob:synthetic']);
});
for (const guard of ['pending', 'missing', 'changed']) test(`download refuses ${guard} identity without side effects`, () => {
  const h = harness(); if (guard === 'pending') h.context.sessionPending.current = true; else h.context.namespaceRef.current = guard === 'missing' ? null : 'other';
  h.run(); assert.deepEqual(h.events, []); assert.deepEqual(h.timers, []);
});

test('explicit retry after a failed click starts one new download and cleans both URLs', () => {
  const h = harness('click'); h.run(); h.recover(); h.run();
  assert.equal(h.events.filter(e => e[0] === 'click').length, 2);
  assert.equal(h.events.filter(e => e[0] === 'error').length, 1);
  assert.equal(h.events.filter(e => e[0] === 'success').length, 1);
  assert.equal(h.timers.length, 2); h.timers.forEach(fn => fn());
  assert.equal(h.events.filter(e => e[0] === 'revoke').length, 2);
});
