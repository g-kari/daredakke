import test from 'node:test';
import assert from 'node:assert/strict';
import { personDraftChanged, accountDraftChanged } from '../src/lib/drafts.ts';

const blankPerson = { name: '', aliases: '', tags: '', notes: '' };
const blankAccount = { service: 'Discord', label: '', url: '', personId: 'none' };

test('closed and unchanged forms have no unsaved input', () => {
  assert.equal(personDraftChanged(null, blankPerson), false);
  assert.equal(accountDraftChanged(null, blankAccount), false);
  assert.equal(personDraftChanged({ ...blankPerson }, blankPerson), false);
  assert.equal(accountDraftChanged({ ...blankAccount }, blankAccount), false);
});
test('blank new-person fields and delimiters normalize to no stored changes', () => {
  assert.equal(personDraftChanged({ name: '  ', aliases: ', 、\n', tags: '\n', notes: ' \n ' }, blankPerson), false);
});
test('each person field and all account fields detect edited inputs', () => {
  for (const [field, value] of Object.entries({ name: 'Synthetic friend', aliases: 'Alias', tags: 'test', notes: 'Unsaved synthetic note' })) {
    assert.equal(personDraftChanged({ ...blankPerson, [field]: value }, blankPerson), true, field);
  }
  for (const [field, value] of Object.entries({ service: 'X', label: 'Synthetic', url: 'invalid-but-unsaved', personId: 'synthetic-person' })) {
    assert.equal(accountDraftChanged({ ...blankAccount, [field]: value }, blankAccount), true, field);
  }
});
test('returning fields to their initial values clears dirty state', () => {
  const person = { id: 'p', name: 'Synthetic', aliases: 'Alias', tags: 'test', notes: 'Initial note' };
  assert.equal(personDraftChanged({ ...person, notes: ' Initial note\n' }, person), false);
  const account = { id: 'a', service: 'X', label: 'Sample', url: 'https://x.com/synthetic_test', personId: 'p' };
  assert.equal(accountDraftChanged({ ...account, label: ' Sample ', url: 'https://twitter.com/SYNTHETIC_TEST?ref=test' }, account), false);
});
test('edited delimiters in existing aliases cannot hide a real array change', () => {
  const initial = { ...blankPerson, id: 'p', name: 'Synthetic', aliases: 'a,b' };
  assert.equal(personDraftChanged({ ...initial, aliases: 'a, b' }, initial), true);
});
test('account URL normalization accepts equivalent IDs, profile hosts and tracking parameters', () => {
  const fixtures = [
    ['X', '@Synthetic_test', 'https://twitter.com/synthetic_TEST?ref=test'],
    ['Discord', '100000000000000001', 'https://discord.com/users/100000000000000001/'],
    ['VRChat', 'usr_00000000-0000-4000-8000-000000000001', 'https://vrchat.com/home/user/usr_00000000-0000-4000-8000-000000000001'],
  ];
  for (const [service, a, b] of fixtures) {
    const initial = { ...blankAccount, service, url: a };
    assert.equal(accountDraftChanged({ ...initial, url: b }, initial), false, service);
  }
});
test('invalid URL inputs stay dirty without throwing or silently rewriting the form', () => {
  const initial = { ...blankAccount, service: 'X', url: '@synthetic_test' };
  const draft = { ...initial, url: 'https://invalid.example/unsaved' };
  assert.equal(accountDraftChanged(draft, initial), true);
  assert.equal(draft.url, 'https://invalid.example/unsaved');
});
