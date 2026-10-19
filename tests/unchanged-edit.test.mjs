import assert from 'node:assert/strict';
import test from 'node:test';
import { demoData, validateData, sameRecordData, change, undoChange } from '../src/domain/records.ts';

test('canonical stored-equivalent whitespace/URL variants compare unchanged without mutation', () => {
  const before = demoData(), after = structuredClone(before), snapshot = structuredClone(before);
  after.people[0].name = '  ' + after.people[0].name + '  ';
  after.people[0].notes = '\n' + after.people[0].notes + '\n';
  const account = after.accounts.find(a => a.service === 'X');
  account.url = account.url.replace('x.com/', 'www.twitter.com/').toUpperCase().replace('HTTPS://WWW.TWITTER.COM/', 'https://www.twitter.com/') + '/?utm_synthetic=1#fragment';
  assert.equal(sameRecordData(before, after), true);
  assert.deepEqual(before, snapshot);
});
for (const [name, mutate] of [
  ['person name', d => { d.people[0].name += ' changed'; }],
  ['notes', d => { d.people[0].notes += '\nchanged'; }],
  ['alias value', d => { d.people[0].aliases[0] += ' changed'; }],
  ['alias order', d => { d.people[0].aliases.reverse(); }],
  ['tag order', d => { d.people[0].tags.reverse(); }],
  ['person order', d => { d.people.reverse(); }],
  ['account order', d => { d.accounts.reverse(); }],
  ['label', d => { d.accounts[0].label += ' changed'; }],
  ['relationship', d => { d.accounts[0].personId = null; }],
  ['URL', d => { const a = d.accounts.find(a => a.service === 'X'); a.url = 'https://x.com/synthetic_new'; }],
  ['color', d => { d.people[0].color = '#147d89'; }],
]) test('meaningful ' + name + ' remains a change', () => {
  const before = demoData(), after = structuredClone(before); mutate(after);
  assert.equal(sameRecordData(before, after), false);
});
test('invalid values are not accepted as unchanged', () => {
  const before = demoData(), after = structuredClone(before); after.people[0].name = '   ';
  assert.throws(() => sameRecordData(before, after));
});
test('existing change and undo semantics remain opt-in, not globally deduplicated', () => {
  const state = { data: validateData(demoData()), undo: [] };
  const next = change(state, state.data, 'explicit import');
  assert.equal(next.undo.length, 1);
  assert.deepEqual(undoChange(next), state);
});
