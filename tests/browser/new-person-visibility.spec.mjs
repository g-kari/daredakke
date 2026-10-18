import { test, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:4317';
const namespaceA = 'u_' + 'a'.repeat(64), namespaceB = 'u_' + 'b'.repeat(64);
const fixtures = new WeakMap();
const blank = () => ({ people: [], accounts: [] });
const fixture = () => ({
  people: [
    { id: 'existing-first', name: '既存の人', aliases: ['Existing Alias'], tags: ['写真'], notes: 'Existing note remains unchanged', color: '#4f5fcb' },
    // Deliberately the same display name as the new person. A name-only detail
    // assertion cannot prove that the created record, rather than this one, won.
    { id: 'existing-same-name', name: '追加した人', aliases: ['Older Alias'], tags: ['ゲーム'], notes: 'Older same-name record', color: '#147d89' },
  ],
  accounts: [
    { id: 'existing-discord', service: 'Discord', label: 'existing_voice', key: 'Discord:100000000000000001', url: 'https://discord.com/users/100000000000000001', personId: 'existing-first' },
    { id: 'existing-x', service: 'X', label: 'existing_signal', key: 'X:existing_signal', url: 'https://x.com/existing_signal', personId: 'existing-first' },
    { id: 'existing-vrc', service: 'VRChat', label: 'Existing Garden', key: 'VRChat:usr_00000000-0000-4000-8000-000000000001', url: 'https://vrchat.com/home/user/usr_00000000-0000-4000-8000-000000000001', personId: 'existing-first' },
    { id: 'unresolved-duplicate', service: 'X', label: 'Unresolved signal', key: 'X:existing_signal', url: 'https://x.com/existing_signal', personId: null },
  ],
});
const draft = { name: '追加した人', aliases: 'Created Alias', tags: '制作', notes: 'Created note [literal].+$' };
const editor = page => page.getByRole('dialog', { name: '人を追加', exact: true });
// CSS locators intentionally allow inspection of the inert background while
// the mobile profile is open. Interactions still use the real accessible UI.
const queryInput = page => page.locator('input[aria-label="記録を検索"]');
const activeTab = page => page.locator('[role="tab"][data-state="active"]');
const serviceButton = (page, service) => page.locator('.service-filter').filter({ hasText: service });
const createdRow = page => page.locator('.person-row').filter({ hasText: draft.aliases });
const profile = (page, info) => info.project.use.isMobile
  ? page.getByRole('dialog', { name: draft.name, exact: true })
  : page.getByRole('article', { name: draft.name + 'のプロフィール', exact: true });

async function start(page, data = fixture()) {
  const api = {
    namespace: namespaceA,
    states: { demo: { data: structuredClone(data), undo: [] }, personal: { data: blank(), undo: [] } },
    revisions: { demo: 0, personal: 0 }, posts: [], commits: [], errors: [], violations: [],
    nextFailure: null, postGate: null, sessionGate: null,
  };
  api.initial = structuredClone(api.states);
  fixtures.set(page, api);
  page.on('pageerror', error => api.errors.push(error.message));
  // The established registration fixture exercises the real callback, not
  // native WebMCP browser interoperability or an external model connection.
  await page.addInitScript(() => {
    window.__daredakkeTools = new Map();
    Object.defineProperty(document, 'modelContext', { configurable: true, value: {
      registerTool(tool) { window.__daredakkeTools.set(tool.name, tool); },
    } });
  });
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const deny = reason => { api.violations.push(reason); return route.abort(); };
    if (url.origin !== origin) return deny('External request: ' + request.method() + ' ' + url.origin + url.pathname);
    if (!url.pathname.startsWith('/api/')) {
      if (request.method() !== 'GET') return deny('Non-GET asset request');
      return route.continue();
    }
    if (url.pathname === '/api/session' && !url.search && request.method() === 'GET') {
      if (api.sessionGate) { const gate = api.sessionGate; api.sessionGate = null; await gate.promise; }
      return route.fulfill({ json: { namespace: api.namespace } });
    }
    if (url.pathname !== '/api/records') return deny('Unexpected API: ' + request.method() + ' ' + url.pathname);
    if (request.method() === 'GET') {
      const scope = url.searchParams.get('scope');
      if (!['demo', 'personal'].includes(scope) || url.searchParams.size !== 1) return deny('Unexpected records GET query');
      return route.fulfill({ json: { namespace: api.namespace, revision: api.revisions[scope], state: api.states[scope] } });
    }
    if (request.method() !== 'POST' || url.search) return deny('Unexpected records method or query');
    const body = request.postDataJSON();
    api.posts.push(body);
    if (api.postGate) { const gate = api.postGate; api.postGate = null; await gate.promise; }
    if (api.nextFailure) { const failure = api.nextFailure; api.nextFailure = null; return route.fulfill(failure); }
    if (body.expectedNamespace !== api.namespace) return route.fulfill({ status: 409, json: { code: 'identity_changed', error: 'Synthetic owner changed' } });
    if (!['demo', 'personal'].includes(body.scope) || request.headers()['x-friend-record'] !== '1' || body.revision !== api.revisions[body.scope]) return deny('Invalid synthetic write scope, revision or marker');
    api.states[body.scope] = structuredClone(body.state);
    api.revisions[body.scope]++;
    api.commits.push(structuredClone(body));
    return route.fulfill({ json: { revision: api.revisions[body.scope] } });
  });
  const gate = key => {
    let release;
    api[key] = { promise: new Promise(resolve => { release = resolve; }) };
    return release;
  };
  api.pausePost = () => gate('postGate');
  api.pauseSession = () => gate('sessionGate');
  await page.goto('/');
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__daredakkeTools.has('search_friend_records'))).toBe(true);
  return api;
}

test.beforeEach(async ({ page }, info) => {
  if (!info.project.use.isMobile) await page.setViewportSize({ width: 1440, height: 900 });
});
test.afterEach(async ({ page }) => {
  const api = fixtures.get(page);
  if (!api) return;
  expect(api.violations, 'Only the exact loopback UI and bounded synthetic API are allowed').toEqual([]);
  expect(api.errors, 'The actual built UI must not throw').toEqual([]);
  expect(api.states.personal, 'The other workspace must remain unchanged').toEqual(api.initial.personal);
});

async function conditions(page, { tab = '人', service = 'すべて', query = '' } = {}) {
  await page.getByRole('tab', { name: new RegExp('^' + tab) }).click();
  if (service !== 'すべて') await page.getByRole('button', { name: service, exact: true }).click();
  await queryInput(page).fill(query);
}
async function openDraft(page) {
  await page.getByRole('button', { name: '人を追加', exact: true }).click();
  await editor(page).getByLabel('名前 必須', { exact: true }).fill(draft.name);
  await editor(page).getByLabel('別名', { exact: true }).fill(draft.aliases);
  await editor(page).getByLabel('タグ', { exact: true }).fill(draft.tags);
  await editor(page).getByRole('textbox', { name: 'メモ', exact: true }).fill(draft.notes);
}
async function saveDraft(page) {
  await editor(page).getByRole('button', { name: '保存する', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
}
function expectOneCreation(api) {
  expect(api.posts).toHaveLength(1);
  expect(api.commits).toHaveLength(1);
  const state = api.states.demo, before = api.initial.demo.data;
  const created = state.data.people.filter(person => !before.people.some(old => old.id === person.id));
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ name: draft.name, aliases: [draft.aliases], tags: [draft.tags], notes: draft.notes });
  expect(state.data.people.filter(person => before.people.some(old => old.id === person.id))).toEqual(before.people);
  expect(state.data.accounts).toEqual(before.accounts);
  expect(state.undo).toHaveLength(1);
  expect(state.undo[0].data).toEqual(before);
  expect(state.undo[0].label).toBe('人を追加しました');
  expect(api.posts[0].expectedNamespace).toBe(namespaceA);
  return created[0];
}
async function expectCreated(page, info, { query = '', clearedQuery = false, clearedService = false } = {}) {
  await expect(activeTab(page)).toHaveText(/^人/);
  await expect(queryInput(page)).toHaveValue(query);
  await expect(serviceButton(page, 'すべて')).toHaveAttribute('aria-pressed', 'true');
  await expect(createdRow(page)).toHaveCount(1);
  await expect(createdRow(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(profile(page, info)).toBeVisible();
  await expect(profile(page, info).getByText(draft.notes, { exact: true })).toBeVisible();
  await expect(profile(page, info).getByText('Older same-name record', { exact: true })).toHaveCount(0);
  if (clearedQuery) await expect(page.locator('[data-sonner-toast]').filter({ hasText: '検索' })).toBeVisible();
  if (clearedService) await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'サービス' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}
async function closeProfile(page, info, method = 'Escape') {
  if (!info.project.use.isMobile) return;
  if (method === 'Close') await profile(page, info).getByRole('button', { name: 'Close', exact: true }).click();
  else await page.keyboard.press('Escape');
  await expect(profile(page, info)).toHaveCount(0);
  await expect(page.locator('.person-sheet')).toHaveCount(0);
  await expect(createdRow(page)).toBeVisible();
  await expect(createdRow(page)).toBeFocused();
}

const searches = [
  { label: 'empty search', query: '', expected: '' },
  { label: 'whitespace-only raw search', query: ' \u3000  ', expected: ' \u3000  ' },
  { label: 'matching raw multi-field search', query: '  CREATED\u3000制作 [literal].+$  ', expected: '  CREATED\u3000制作 [literal].+$  ' },
  { label: 'nonmatching search', query: 'Existing Alias', expected: '' },
];
for (const search of searches) {
  test('successful creation shows the exact new record with ' + search.label, async ({ page }, info) => {
    const api = await start(page);
    await conditions(page, { query: search.query });
    await openDraft(page); await saveDraft(page);
    expectOneCreation(api);
    await expectCreated(page, info, { query: search.expected, clearedQuery: search.query !== search.expected });
    if (search.label === 'empty search') await info.attach('new-person-visible', {
      body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png',
    });
    await closeProfile(page, info);
    // Normal navigation must not change or duplicate the saved record.
    await page.getByRole('tab', { name: /^未整理/ }).click();
    await page.getByRole('tab', { name: /^人/ }).click();
    await createdRow(page).click();
    await expect(profile(page, info).getByText(draft.notes, { exact: true })).toBeVisible();
    expectOneCreation(api);
  });
}
for (const service of ['Discord', 'X', 'VRChat']) {
  for (const matches of [true, false]) {
    test(`successful creation clears ${service} but ${matches ? 'keeps matching' : 'clears nonmatching'} combined search`, async ({ page }, info) => {
      const api = await start(page), query = matches ? '  CREATED\u3000制作  ' : 'existing_voice';
      await conditions(page, { service, query });
      await openDraft(page); await saveDraft(page);
      expectOneCreation(api);
      await expectCreated(page, info, { query: matches ? query : '', clearedQuery: !matches, clearedService: true });
      await closeProfile(page, info, 'Close');
      await createdRow(page).click();
      await expect(profile(page, info).getByText(draft.notes, { exact: true })).toBeVisible();
      expectOneCreation(api);
    });
  }
}
for (const tab of ['未整理', '重複候補']) {
  test('creation from ' + tab + ' moves to people and preserves matching query', async ({ page }, info) => {
    const api = await start(page), query = '  CREATED\u3000制作  ';
    await conditions(page, { tab, service: 'X', query });
    await openDraft(page); await saveDraft(page);
    expectOneCreation(api);
    await expectCreated(page, info, { query, clearedService: true });
    await closeProfile(page, info);
    await expect(createdRow(page)).toBeVisible();
  });
}

test('empty workspace creation is visible and contextual account addition uses the created ID', async ({ page }, info) => {
  const api = await start(page, blank());
  await conditions(page, { tab: '未整理', service: 'VRChat', query: 'no_match' });
  await openDraft(page); await saveDraft(page);
  const created = expectOneCreation(api);
  await expectCreated(page, info, { clearedQuery: true, clearedService: true });
  await profile(page, info).getByRole('button', { name: 'アカウントを追加', exact: true }).click();
  const account = page.getByRole('dialog', { name: 'アカウントを追加', exact: true });
  await expect(account.getByRole('combobox', { name: 'アカウントの紐づけ先' })).toHaveText(draft.name);
  await account.getByLabel('表示名', { exact: true }).fill('Created voice');
  await account.getByLabel('プロフィールURL / ID 必須', { exact: true }).fill('100000000000000009');
  await account.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(account).toHaveCount(0);
  expect(api.commits).toHaveLength(2);
  expect(api.states.demo.data.people).toEqual([created]);
  expect(api.states.demo.data.accounts).toHaveLength(1);
  expect(api.states.demo.data.accounts[0].personId).toBe(created.id);
  expect(api.states.demo.undo).toHaveLength(2);
  await expect(profile(page, info).getByText('Created voice', { exact: true })).toBeVisible();
});

test('same-name existing record is not selected or used for contextual account addition', async ({ page }, info) => {
  const api = await start(page);
  await conditions(page, { service: 'Discord', query: 'Existing Alias' });
  await openDraft(page); await saveDraft(page);
  const created = expectOneCreation(api);
  await expectCreated(page, info, { clearedQuery: true, clearedService: true });
  await profile(page, info).getByRole('button', { name: 'アカウントを追加', exact: true }).click();
  const account = page.getByRole('dialog', { name: 'アカウントを追加', exact: true });
  await account.getByLabel('プロフィールURL / ID 必須', { exact: true }).fill('100000000000000009');
  await account.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(account).toHaveCount(0);
  expect(api.posts).toHaveLength(2);
  expect(api.states.demo.data.accounts.at(-1).personId).toBe(created.id);
  expect(api.states.demo.data.people.slice(0, 2)).toEqual(api.initial.demo.data.people);
  expect(api.states.demo.data.accounts.slice(0, 4)).toEqual(api.initial.demo.data.accounts);
});

test('closing a newly created profile returns to its row rather than a previously opened person', async ({ page }, info) => {
  const api = await start(page);
  const oldRow = page.locator('.person-row[aria-label="既存の人の記録を開く"]');
  await oldRow.click();
  if (info.project.use.isMobile) {
    const oldProfile = page.getByRole('dialog', { name: '既存の人', exact: true });
    await oldProfile.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(oldRow).toBeFocused();
  }
  await openDraft(page); await saveDraft(page); expectOneCreation(api);
  await expectCreated(page, info);
  if (info.project.use.isMobile) {
    await closeProfile(page, info, 'Close');
    await expect(createdRow(page)).toBeFocused();
    await expect(createdRow(page)).toBeInViewport();
    await expect(oldRow).not.toBeFocused();
  }
  await createdRow(page).click();
  await expect(profile(page, info).getByText(draft.notes, { exact: true })).toBeVisible();
  expectOneCreation(api);
});

async function expectDraftAndConditions(page, tab, query, service) {
  await expect(editor(page).getByLabel('名前 必須', { exact: true })).toHaveValue(draft.name);
  await expect(editor(page).getByLabel('別名', { exact: true })).toHaveValue(draft.aliases);
  await expect(editor(page).getByLabel('タグ', { exact: true })).toHaveValue(draft.tags);
  await expect(editor(page).getByRole('textbox', { name: 'メモ', exact: true })).toHaveValue(draft.notes);
  await expect(activeTab(page)).toHaveText(new RegExp('^' + tab));
  await expect(queryInput(page)).toHaveValue(query);
  await expect(serviceButton(page, service)).toHaveAttribute('aria-pressed', 'true');
}

test('pending and repeated save preserve draft and view until one successful POST finishes', async ({ page }, info) => {
  const api = await start(page), release = api.pausePost();
  await conditions(page, { tab: '重複候補', service: 'X', query: 'Existing Alias' });
  await openDraft(page);
  await editor(page).getByRole('button', { name: '保存する', exact: true }).click();
  await expect.poll(() => api.posts.length).toBe(1);
  await expect(editor(page).getByRole('button', { name: '保存中…', exact: true })).toBeDisabled();
  await expectDraftAndConditions(page, '重複候補', 'Existing Alias', 'X');
  await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  await expect(editor(page)).toBeVisible();
  expect(api.posts).toHaveLength(1); expect(api.commits).toHaveLength(0);
  expect(api.states).toEqual(api.initial);
  release();
  await expect(editor(page)).toHaveCount(0);
  expectOneCreation(api);
  await expectCreated(page, info, { clearedQuery: true, clearedService: true });
});

test('failed creation leaves view and draft intact and an explicit retry creates once', async ({ page }, info) => {
  const api = await start(page);
  api.nextFailure = { status: 500, json: { error: 'Synthetic save failure' } };
  await conditions(page, { tab: '未整理', service: 'Discord', query: 'Existing Alias' });
  await openDraft(page);
  await editor(page).getByRole('button', { name: '保存する', exact: true }).click();
  await expect(editor(page).getByRole('alert')).toHaveText('Synthetic save failure');
  await expectDraftAndConditions(page, '未整理', 'Existing Alias', 'Discord');
  expect(api.posts).toHaveLength(1); expect(api.commits).toHaveLength(0);
  expect(api.states).toEqual(api.initial);
  await saveDraft(page);
  expect(api.posts).toHaveLength(2); expect(api.commits).toHaveLength(1);
  expect(api.states.demo.data.people).toHaveLength(3);
  expect(api.states.demo.undo).toHaveLength(1);
  await expectCreated(page, info, { clearedQuery: true, clearedService: true });
});

for (const [initial, latest, expected] of [
  ['Existing Alias', '  CREATED\u3000制作  ', '  CREATED\u3000制作  '],
  ['CREATED', 'Existing Alias', ''],
]) test('pending creation respects the latest WebMCP search: ' + latest, async ({ page }, info) => {
  const api = await start(page), release = api.pausePost();
  await conditions(page, { service: 'X', query: initial });
  await openDraft(page);
  await editor(page).getByRole('button', { name: '保存する', exact: true }).click();
  await expect.poll(() => api.posts.length).toBe(1);
  await page.evaluate(query => window.__daredakkeTools.get('search_friend_records').execute({ query }), latest);
  await expect(queryInput(page)).toHaveValue(latest);
  await expect(serviceButton(page, 'すべて')).toHaveAttribute('aria-pressed', 'true');
  await expect(editor(page).getByRole('textbox', { name: 'メモ', exact: true })).toHaveValue(draft.notes);
  release();
  await expect(editor(page)).toHaveCount(0); expectOneCreation(api);
  await expectCreated(page, info, { query: expected, clearedQuery: latest !== expected });
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'サービス' })).toHaveCount(0);
});

test('cancel keeps the draft until explicit discard and never changes filters or saves', async ({ page }) => {
  const api = await start(page);
  await conditions(page, { tab: '重複候補', service: 'VRChat', query: 'Existing Alias' });
  await openDraft(page);
  await editor(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
  const discard = page.getByRole('alertdialog');
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: '編集を続ける', exact: true }).click();
  await expectDraftAndConditions(page, '重複候補', 'Existing Alias', 'VRChat');
  await editor(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
  await discard.getByRole('button', { name: '入力を破棄する', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(activeTab(page)).toHaveText(/^重複候補/);
  await expect(queryInput(page)).toHaveValue('Existing Alias');
  await expect(serviceButton(page, 'VRChat')).toHaveAttribute('aria-pressed', 'true');
  expect(api.posts).toHaveLength(0); expect(api.states).toEqual(api.initial);
});

test('same-owner recheck preserves the new draft and later creation follows visibility rules', async ({ page }, info) => {
  const api = await start(page), release = api.pauseSession();
  await conditions(page, { tab: '未整理', service: 'X', query: 'Existing Alias' });
  await openDraft(page);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('status')).toHaveText('ログインを確認しています…');
  await expect(editor(page)).toHaveCount(0);
  expect(api.posts).toHaveLength(0);
  release();
  await expectDraftAndConditions(page, '未整理', 'Existing Alias', 'X');
  await saveDraft(page); expectOneCreation(api);
  await expectCreated(page, info, { clearedQuery: true, clearedService: true });
});

test('changed owner clears the new draft instead of submitting it', async ({ page }) => {
  const api = await start(page);
  await conditions(page, { tab: '未整理', service: 'X', query: 'Existing Alias' });
  await openDraft(page); api.namespace = namespaceB;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert').filter({ hasText: 'ログイン' })).toBeVisible();
  await expect(editor(page)).toHaveCount(0);
  await expect(page.locator('.person-row')).toHaveCount(0);
  expect(api.posts).toHaveLength(0); expect(api.states).toEqual(api.initial);
});

test('owner change during pending POST does not apply success navigation or retain the draft', async ({ page }) => {
  const api = await start(page), release = api.pausePost();
  await conditions(page, { tab: '重複候補', service: 'X', query: 'Existing Alias' });
  await openDraft(page);
  await editor(page).getByRole('button', { name: '保存する', exact: true }).click();
  await expect.poll(() => api.posts.length).toBe(1);
  api.namespace = namespaceB; release();
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic owner changed' })).toBeVisible();
  await expect(editor(page)).toHaveCount(0);
  await expect(page.locator('.person-row')).toHaveCount(0);
  expect(api.posts).toHaveLength(1); expect(api.commits).toHaveLength(0);
  expect(api.states).toEqual(api.initial);
});

test('editing an existing person does not apply new-person filter or tab changes', async ({ page }, info) => {
  const api = await start(page);
  await conditions(page, { service: 'Discord', query: 'Existing Alias' });
  await page.getByRole('button', { name: '既存の人の記録を開く', exact: true }).click();
  const existing = info.project.use.isMobile ? page.getByRole('dialog', { name: '既存の人', exact: true }) : page.getByRole('article', { name: '既存の人のプロフィール', exact: true });
  await existing.getByRole('button', { name: '編集', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '人の記録を編集', exact: true });
  await edit.getByRole('textbox', { name: 'メモ', exact: true }).fill('Explicitly edited existing note');
  await edit.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(queryInput(page)).toHaveValue('Existing Alias');
  await expect(serviceButton(page, 'Discord')).toHaveAttribute('aria-pressed', 'true');
  expect(api.posts).toHaveLength(1); expect(api.states.demo.data.people).toHaveLength(2);
  expect(api.states.demo.data.people[0]).toEqual({ ...api.initial.demo.data.people[0], notes: 'Explicitly edited existing note' });
  expect(api.states.demo.data.people[1]).toEqual(api.initial.demo.data.people[1]);
  expect(api.states.demo.data.accounts).toEqual(api.initial.demo.data.accounts);
  expect(api.states.demo.undo).toHaveLength(1);
});
