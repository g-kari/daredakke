import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const directory = path.dirname(fileURLToPath(import.meta.url));
const options = { sourceRoot: path.resolve(directory, '..'), depsRoot: path.resolve(directory, '../node_modules'), expectation: 'fixed' };
const tsCandidates = [
  path.join(options.depsRoot, 'typescript/lib/typescript.js'),
  path.join(options.depsRoot, 'node_modules/typescript/lib/typescript.js'),
];
const tsPath = tsCandidates.find(candidate => fs.existsSync(candidate));
assert.ok(tsPath, 'TypeScript must already exist under --deps-root; this test never installs dependencies.');
const ts = (await import(pathToFileURL(tsPath).href)).default;
const source = relative => fs.readFileSync(path.join(options.sourceRoot, relative), 'utf8');
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = code => 'data:text/javascript;base64,' + Buffer.from(compile(code)).toString('base64');
const recordsUrl = moduleUrl(source('src/domain/records.ts'));
const records = await import(recordsUrl);
const drafts = await import(moduleUrl(source('src/lib/drafts.ts').replace(/from ['"]\.\.\/domain\/records\.ts['"]/, "from '" + recordsUrl + "'")));
const appText = source('src/app.tsx');
const ast = ts.createSourceFile('app.tsx', appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  ts.forEachChild(node, visit);
}
visit(ast);
function call(name, context, ...args) {
  assert.ok(functions.has(name), 'Actual source callback exists: ' + name);
  const run = new Function(...Object.keys(context), compile(functions.get(name).getText(ast)) + '\nreturn ' + name + ';')(...Object.values(context));
  return run(...args);
}
const fingerprint = relative => {
  const bytes = fs.readFileSync(path.join(options.sourceRoot, relative));
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    gitBlobSha1: createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex'),
  };
};
const expectedQuery = '保持する検索';
const expectedServiceFilter = 'Discord';
const expectedTab = 'people';

function harness(kind) {
  // All records originate from the repository's explicitly synthetic demo.
  const beforeMeaningfulEdit = records.demoData();
  const afterMeaningfulEdit = structuredClone(beforeMeaningfulEdit);
  afterMeaningfulEdit.people[0].notes = 'A meaningful edited synthetic note';
  const initialState = records.change({ data: beforeMeaningfulEdit, undo: [] }, afterMeaningfulEdit, 'A meaningful edit');
  const namespace = 'a'.repeat(64);
  const context = {
    ...records, ...drafts, state: initialState, data: initialState.data,
    scope: 'demo', namespace, namespaceRef: { current: namespace }, revision: 1,
    busy: false, sessionPending: { current: false }, identityEpoch: { current: 1 },
    personDraft: null, accountDraft: null,
    personDraftInitial: { current: null }, accountDraftInitial: { current: null },
    draftFocus: { current: null }, discardFocus: { current: null }, discard: null,
    filtersRef: { current: { query: expectedQuery, serviceFilter: expectedServiceFilter } },
    profileFocus: { current: null },
    query: expectedQuery, serviceFilter: expectedServiceFilter, tab: expectedTab,
    blankPerson: () => ({ name: '', aliases: '', tags: '', notes: '' }),
    split: value => value.split(/[,、\n]/).map(item => item.trim()).filter(Boolean),
    // Successful synthetic HTTP responses never indicate an identity change.
    identityChanged: () => false,
    crypto: { randomUUID: () => { throw new Error('An existing edit must preserve its ID.'); } },
  };
  const writes = [], notices = [];
  context.toast = { success: text => notices.push({ kind: 'success', text }), error: text => notices.push({ kind: 'error', text }), info: text => notices.push({ kind: 'info', text }) };
  context.fetch = async (url, request) => {
    assert.equal(url, '/api/records');
    assert.equal(request.method, 'POST');
    const payload = JSON.parse(request.body);
    assert.deepEqual(payload.state.data, afterMeaningfulEdit, 'Unchanged edit must preserve all actual records.');
    writes.push(payload);
    return Response.json({ revision: context.revision + 1 });
  };
  for (const [setter, key] of [
    ['Busy', 'busy'], ['Error', 'error'], ['FormError', 'formError'],
    ['PersonDraft', 'personDraft'], ['AccountDraft', 'accountDraft'],
    ['Revision', 'revision'], ['Selected', 'selected'], ['Discard', 'discard'],
    ['Query', 'query'], ['ServiceFilter', 'serviceFilter'], ['Tab', 'tab'],
  ]) context['set' + setter] = value => { context[key] = value; };
  context.setState = value => { context.state = value; context.data = value.data; };
  // Execute source callbacks, not copied implementations. Wrappers resolve current
  // synthetic render values on each call, as the component does after a render.
  for (const name of functions.keys()) {
    if (!Object.hasOwn(context, name)) context[name] = (...args) => call(name, context, ...args);
  }
  return { kind, context, writes, notices, beforeMeaningfulEdit, afterMeaningfulEdit, initialState };
}

const outcomes = [];
for (const kind of ['person', 'account']) {
  const h = harness(kind), c = h.context;
  for (let repeat = 0; repeat < 10; repeat++) {
    if (kind === 'person') {
      c.editPerson(c.data.people[0]);
      assert.equal(drafts.personDraftChanged(c.personDraft, c.personDraftInitial.current), false);
      await c.submitPerson({ preventDefault() {} });
      assert.equal(c.personDraft, null, 'Successful unchanged save dismisses the person form.');
    } else {
      c.editAccount(c.data.accounts[0]);
      assert.equal(drafts.accountDraftChanged(c.accountDraft, c.accountDraftInitial.current), false);
      await c.submitAccount({ preventDefault() {} });
      assert.equal(c.accountDraft, null, 'Successful unchanged save dismisses the account form.');
    }
    assert.deepEqual(c.state.data, h.afterMeaningfulEdit, 'No real data changed.');
    assert.equal(c.query, expectedQuery, 'Search text remains exact.');
    assert.equal(c.serviceFilter, expectedServiceFilter, 'Service filter remains exact.');
    assert.equal(c.tab, expectedTab, 'Current tab remains exact.');
    assert.deepEqual(c.filtersRef.current, { query: expectedQuery, serviceFilter: expectedServiceFilter });
    if (repeat === 0 && options.expectation === 'defect') {
      assert.equal(c.state.undo.length, 2, 'The very first unchanged save already consumes one history slot.');
      assert.deepEqual(c.state.undo[0].data, h.afterMeaningfulEdit);
    }
  }
  let undone = c.state;
  for (let count = 0; count < 10; count++) undone = records.undoChange(undone);
  const retainedOriginal = c.state.undo.some(item => JSON.stringify(item.data) === JSON.stringify(h.beforeMeaningfulEdit));
  const restoredOriginal = JSON.stringify(undone.data) === JSON.stringify(h.beforeMeaningfulEdit);
  if (options.expectation === 'defect') {
    assert.equal(h.writes.length, 10, 'Ten unchanged edit saves issue ten synthetic POSTs.');
    assert.equal(c.state.undo.length, 10);
    assert.equal(retainedOriginal, false, 'Unchanged saves evict the meaningful prior snapshot.');
    assert.deepEqual(undone.data, h.afterMeaningfulEdit, 'Undoing all ten duplicates cannot recover the original note.');
    assert.equal(restoredOriginal, false);
  } else {
    assert.equal(h.writes.length, 0, 'A fixed unchanged edit must not POST.');
    assert.deepEqual(c.state, h.initialState, 'A fixed unchanged edit must preserve every undo entry.');
    assert.equal(retainedOriginal, true);
    assert.deepEqual(undone.data, h.beforeMeaningfulEdit, 'Meaningful restoration must remain usable.');
  }
  assert.equal(h.notices.some(item => item.kind === 'info' && /絞り込み/.test(item.text)), false, 'No filter-reset notice may be emitted.');
  if (options.expectation === 'fixed') { assert.equal(h.notices.filter(item => item.kind === 'info' && item.text === '変更はありません。記録と復元履歴はそのままです。').length, 10); assert.equal(h.notices.some(item => item.kind === 'success'), false); }
  assert.equal(h.notices.some(item => item.kind === 'error'), false, 'There must be no hidden submit failure.');
  outcomes.push({
    kind,
    unchangedSaves: 10,
    syntheticPostRequests: h.writes.length,
    recordDataUnchanged: true,
    undoEntriesBefore: 1,
    undoEntriesAfter: c.state.undo.length,
    originalNoteSnapshotRetained: retainedOriginal,
    undoAllTenRestoresOriginalNote: restoredOriginal,
    queryServiceAndTabUnchanged: true,
  });
}
console.log(JSON.stringify({
  result: 'PASS',
  expectation: options.expectation,
  baselineCommit: 'e88cc6ecc860de9008473ff1d0e9369a6535cb50',
  method: 'Exact-source callback execution with synthetic fetch responses, not rendered-browser or D1 verification.',
  sourceRoot: options.sourceRoot,
  typescriptPath: tsPath,
  files: Object.fromEntries(['src/app.tsx', 'src/domain/records.ts', 'src/lib/drafts.ts'].map(relative => [relative, fingerprint(relative)])),
  cases: outcomes,
}, null, 2));


for (const kind of ['person', 'account']) for (const guard of ['busy', 'session-pending', 'missing-namespace', 'changed-namespace']) {
  const h = harness(kind), c = h.context;
  if (kind === 'person') c.editPerson(c.data.people[0]); else c.editAccount(c.data.accounts[0]);
  if (guard === 'busy') c.busy = true;
  if (guard === 'session-pending') c.sessionPending.current = true;
  if (guard === 'missing-namespace') c.namespace = null;
  if (guard === 'changed-namespace') c.namespaceRef.current = 'b'.repeat(64);
  if (kind === 'person') await c.submitPerson({ preventDefault() {} }); else await c.submitAccount({ preventDefault() {} });
  assert.equal(h.writes.length, 0); assert.equal(h.notices.length, 0);
  assert.ok(kind === 'person' ? c.personDraft : c.accountDraft, 'Gated no-op must not close or acknowledge the draft.');
  assert.deepEqual(c.state, h.initialState);
}
console.log('PASS eight existing-edit identity/busy guards');
