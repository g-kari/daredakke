import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { createRecordSearch, searchPeople } from '../src/domain/search.ts';
import { demoData, empty, duplicateGroups } from '../src/domain/records.ts';

// Public fictional fixtures only; actual component callbacks never contact an API.
const data = demoData();
const ids = people => people.map(person => person.id);
const find = (query, service = 'all', records = data) => ids(searchPeople(records, createRecordSearch(query), service));
const source = ts.createSourceFile('app.tsx', fs.readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
let toolExecute;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  if (ts.isObjectLiteralExpression(node) && node.properties.some(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'name' && property.initializer.getText(source) === "'search_friend_records'")) {
    toolExecute = node.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'execute')?.initializer;
  }
  ts.forEachChild(node, visit);
}
visit(source);
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const uiCode = ['search', 'match', 'filteredPeople', 'accountMatch'].map(name => {
  assert.ok(declarations.get(name), `actual ${name} declaration exists`);
  return 'const ' + declarations.get(name).getText(source) + ';';
}).join('\n');
const ui = new Function('data', 'query', 'serviceFilter', 'createRecordSearch', 'searchPeople', compile(uiCode + '\nreturn { people: filteredPeople, accountMatch, hasTerms: search.hasTerms };'));
const runUi = (query, service = 'all', records = data) => ui(records, query, service, createRecordSearch, searchPeople);
function toolHarness(records = data) {
  assert.ok(toolExecute, 'actual WebMCP callback exists');
  const view = { calls: [] };
  const context = { createRecordSearch, searchPeople, empty, sessionPending: { current: false }, stateRef: { current: { data: records } } };
  for (const key of ['Query', 'Tab', 'ServiceFilter']) context['set' + key] = value => { view[key] = value; view.calls.push([key, value]); };
  const run = new Function(...Object.keys(context), compile('return ' + toolExecute.getText(source) + ';'))(...Object.values(context));
  return { run, view, context };
}

test('independent clues across name, aliases, tags, notes and linked accounts must all match', () => {
  for (const query of ['あおい ワールド制作', 'ワールド制作 あおい', 'Ao ワールド制作 集まり', 'あおい fr_demo_aoi Discord', 'sora 週末 Discord']) {
    assert.equal(find(query).length, 1, query);
  }
  assert.deepEqual(find('あおい ワールド制作'), ['demo-aoi']);
  assert.deepEqual(find('sora 週末 Discord'), ['demo-sora']);
});
test('front, trailing, repeated, full-width and mixed whitespace are separators', () => {
  for (const query of ['　あおい　', ' あおい   ワールド制作 ', 'あおい\t\nワールド制作', '\u00a0あおい\u3000ワールド制作\u2028']) {
    assert.deepEqual(find(query), query.trim() === 'あおい' ? ['demo-aoi', 'demo-ao'] : ['demo-aoi']);
  }
});
test('empty and whitespace-only searches restore every record within the active service filter', () => {
  for (const query of ['', ' ', '　\t\n\u00a0']) {
    assert.equal(createRecordSearch(query).hasTerms, false);
    assert.deepEqual(find(query), ids(data.people));
    assert.deepEqual(find(query, 'Discord'), ['demo-aoi', 'demo-sora']);
    assert.deepEqual(find(query, 'VRChat'), ['demo-aoi']);
    assert.deepEqual(find(query, 'X'), ['demo-aoi', 'demo-yuki', 'demo-ao']);
    assert.deepEqual(find(query, 'all', empty()), []);
  }
});
test('every term is required and clues cannot leak across separate people', () => {
  assert.deepEqual(find('あおい nonexistent_keyword'), []);
  assert.deepEqual(find('ワールド制作 ゲーム'), []);
  assert.deepEqual(find('Ao Ao ワールド制作'), ['demo-aoi']);
  assert.deepEqual(find('あおい Discord', 'VRChat'), ['demo-aoi'], 'service filters select people without hiding their other existing searchable accounts');
  assert.deepEqual(find('sora Discord', 'VRChat'), []);
});
test('punctuation and query-operator-looking characters remain literal text', () => {
  for (const query of ['.*', '*', '?', '[a]', '(a)', 'x|y', '-no', '"quoted"', '<script>']) {
    assert.equal(createRecordSearch(query).matches(['plain words only']), false, query);
    assert.equal(createRecordSearch(query).matches(['prefix ' + query + ' suffix']), true, query);
  }
  assert.equal(createRecordSearch('foo|bar').matches(['foo', 'bar']), false);
});
test('old non-whitespace single-term searches and ordering agree with the previous UI contract', () => {
  for (const service of ['all', 'Discord', 'X', 'VRChat']) {
    for (const query of ['あおい', 'AO', 'aoi_demo', 'Discord', 'VRChat', 'X', '@fr_demo_aoi', 'x.com', '週末', '制作', '100000000000000001', 'nonexistent']) {
      const expected = data.people.filter(person => {
        const accounts = data.accounts.filter(account => account.personId === person.id);
        return (service === 'all' || accounts.some(account => account.service === service)) && [person.name, ...person.aliases, ...person.tags, person.notes, ...accounts.flatMap(account => [account.label, account.url, account.service])].join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase());
      });
      assert.deepEqual(find(query, service), ids(expected), `${service}/${query}`);
    }
  }
});
test('search does not modify frozen records, identities, array order or account links', () => {
  const records = structuredClone(data);
  const before = JSON.stringify(records);
  const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };
  freeze(records);
  for (const query of ['', 'あおい ワールド制作', 'Ao X', 'weekend', '　']) searchPeople(records, createRecordSearch(query));
  assert.equal(JSON.stringify(records), before);
});
test('maximum supported records preserve exact per-person account ownership', () => {
  const records = { people: [], accounts: [] };
  for (let p = 0; p < 200; p++) {
    records.people.push({ id: `p-${p}`, name: `Person-${p}`, aliases: [], tags: ['synthetic'], notes: `note-${p}`, color: '#4f5fcb' });
    for (let a = 0; a < 5; a++) records.accounts.push({ id: `a-${p}-${a}`, personId: `p-${p}`, service: 'X', label: `handle-${p}-${a}`, url: `https://x.com/user${p}_${a}`, key: `X:user${p}_${a}` });
  }
  assert.deepEqual(find('note-137 handle-137-4', 'X', records), ['p-137']);
  assert.deepEqual(find('note-137 handle-136-4', 'all', records), []);
  assert.equal(find(' ', 'X', records).length, 200);
});
test('actual UI uses shared AND matching for people, unresolved accounts and duplicate candidates', () => {
  assert.deepEqual(ids(runUi('あおい ワールド制作').people), ['demo-aoi']);
  assert.equal(runUi('　').hasTerms, false);
  assert.deepEqual(data.accounts.filter(account => account.personId === null && runUi('名前 VRChat').accountMatch(account)).map(account => account.id), ['demo-c7']);
  assert.equal(data.accounts.filter(account => account.personId === null && runUi('名前 X').accountMatch(account)).length, 0);
  assert.equal(duplicateGroups(data).filter(group => group.some(runUi('あおい X').accountMatch)).length, 1);
  assert.equal(duplicateGroups(data).filter(group => group.some(runUi('あおい Discord').accountMatch)).length, 0);
});
test('actual UI and WebMCP callback share people results, return shape and raw query echo', () => {
  const h = toolHarness();
  for (const query of ['あおい ワールド制作', 'ワールド制作 Ao', '  sora\t週末  ', '　', 'VRChat', 'not_a_match']) {
    const result = h.run({ query });
    assert.deepEqual(ids(result.people), ids(runUi(query).people));
    for (const person of result.people) assert.deepEqual(person.accounts, data.accounts.filter(account => account.personId === person.id));
    assert.equal(h.view.Query, query);
    assert.equal(h.view.Tab, 'people');
    assert.equal(h.view.ServiceFilter, 'all');
    assert.deepEqual(Object.keys(result), ['people']);
  }
  assert.deepEqual(Object.keys(data), ['people', 'accounts']);
});
test('WebMCP validation preserves the existing 100-code-unit limit before any UI change', () => {
  const h = toolHarness();
  for (const input of [null, {}, { query: 1 }, { query: 'a'.repeat(101) }, { query: '　'.repeat(101) }, { query: '', extra: true }]) assert.throws(() => h.run(input));
  assert.deepEqual(h.view.calls, []);
  assert.doesNotThrow(() => h.run({ query: 'a'.repeat(100) }));
});
test('actual search cannot reveal old records during a pending or cleared identity', () => {
  const h = toolHarness();
  h.context.sessionPending.current = true;
  assert.throws(() => h.run({ query: 'あおい' }), /ログイン確認中/);
  assert.deepEqual(h.view.calls, []);
  h.context.sessionPending.current = false;
  h.context.stateRef.current = null;
  assert.deepEqual(h.run({ query: '' }).people, []);
});
test('the same registered callback searches only the latest current-scope state', () => {
  const h = toolHarness();
  const other = { people: [{ id: 'other', name: 'New scope', aliases: [], tags: ['current'], notes: '', color: '#4f5fcb' }], accounts: [] };
  h.context.stateRef.current = { data: other };
  assert.deepEqual(h.run({ query: 'あおい' }).people, []);
  assert.deepEqual(ids(h.run({ query: 'New current' }).people), ['other']);
});
