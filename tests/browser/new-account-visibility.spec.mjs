import { test, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:4317', namespace = 'u_' + 'a'.repeat(64);
const fixtures = new WeakMap();
const fixture = () => ({ people: [
  { id: 'first', name: 'Existing first', aliases: [], tags: [], notes: 'First unchanged', color: '#4f5fcb' },
  { id: 'target', name: 'Target person', aliases: [], tags: [], notes: 'Exact target owner', color: '#147d89' },
], accounts: [
  { id: 'target-x', service: 'X', label: 'Target existing X', personId: 'target', url: 'https://x.com/target_fixture', key: 'X:target_fixture' },
  { id: 'old-unlinked', service: 'X', label: 'Old unlinked', personId: null, url: 'https://x.com/old_fixture', key: 'X:old_fixture' },
] });
const query = page => page.locator('input[aria-label="記録を検索"]');
const activeTab = page => page.locator('[role="tab"][data-state="active"]');
// CSS inspection also works for inert background filters while a mobile sheet
// is open; interactions occur only before the sheet/modal makes it inert.
const service = (page, name) => page.locator('.service-filter').filter({ hasText: name });
const createdRow = page => page.locator('.account-row').filter({ hasText: 'Created voice' });
async function start(page, initialData = fixture()) {
  const api = { state: { data: initialData, undo: [] }, revision: 0, posts: [], errors: [], denied: [], failure: null, pause: null, sessionPause: null, sessionCalls: 0 };
  fixtures.set(page, api);
  page.on('pageerror', error => api.errors.push(error.message));
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const deny = reason => { api.denied.push(reason); return route.abort(); };
    if (url.origin !== origin) return deny('external request');
    if (!url.pathname.startsWith('/api/')) return request.method() === 'GET' ? route.continue() : deny('non-GET asset');
    if (url.pathname === '/api/session' && !url.search && request.method() === 'GET') { api.sessionCalls++; if (api.sessionPause) await api.sessionPause; return route.fulfill({ json: { namespace } }); }
    if (url.pathname !== '/api/records') return deny('unexpected API');
    if (request.method() === 'GET' && url.searchParams.get('scope') === 'demo' && url.searchParams.size === 1) return route.fulfill({ json: { namespace, state: api.state, revision: api.revision } });
    if (request.method() !== 'POST' || url.search) return deny('unexpected method or query');
    const body = request.postDataJSON(); api.posts.push(body);
    if (body.scope !== 'demo' || body.expectedNamespace !== namespace || body.revision !== api.revision || request.headers()['x-friend-record'] !== '1') return deny('invalid write context');
    if (api.pause) { const gate = api.pause; api.pause = null; await gate; }
    if (api.failure) return route.fulfill(api.failure);
    api.state = structuredClone(body.state); api.revision++;
    return route.fulfill({ json: { revision: api.revision } });
  });
  await page.goto('/'); await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  return api;
}
async function editor(page, label = 'Created voice') {
  await page.getByRole('button', { name: 'アカウントを追加', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'アカウントを追加', exact: true });
  await dialog.getByLabel('表示名', { exact: true }).fill(label);
  await dialog.getByLabel('プロフィールURL / ID').fill('100000000000000009');
  return dialog;
}
async function save(dialog) { await dialog.getByRole('button', { name: '保存する', exact: true }).click(); }
test.afterEach(async ({ page }) => {
  const api = fixtures.get(page); if (!api) return;
  expect(api.denied).toEqual([]); expect(api.errors).toEqual([]);
});

test('new unlinked account opens its list and clears only hiding filters', async ({ page }) => {
  const api = await start(page); await query(page).fill('No matching account'); await service(page, 'X').click();
  const dialog = await editor(page); await save(dialog); await expect(dialog).toBeHidden();
  await expect(activeTab(page)).toContainText('未整理'); await expect(createdRow(page)).toBeVisible();
  await expect(query(page)).toHaveValue(''); await expect(service(page, 'すべて')).toHaveAttribute('aria-pressed', 'true');
  expect(api.posts).toHaveLength(1); expect(api.state.undo).toHaveLength(1);
  expect(api.state.data.accounts.filter(a => a.label === 'Created voice')).toHaveLength(1);
  expect(api.state.data.people).toEqual(fixture().people);
});
test('matching query spelling and service survive new unlinked save', async ({ page }) => {
  await start(page); const raw = '  CREATED\u3000voice  '; await query(page).fill(raw); await service(page, 'Discord').click();
  const dialog = await editor(page); await save(dialog); await expect(dialog).toBeHidden(); await expect(createdRow(page)).toBeVisible();
  await expect(query(page)).toHaveValue(raw); await expect(service(page, 'Discord')).toHaveAttribute('aria-pressed', 'true');
});
test('linked account opens exact selected owner from duplicates and preserves matching owner conditions', async ({ page }, info) => {
  const api = await start(page); await query(page).fill('  Target person  '); await service(page, 'X').click();
  await page.getByRole('tab', { name: /^重複候補/ }).click(); const dialog = await editor(page);
  await dialog.getByRole('combobox', { name: 'アカウントの紐づけ先' }).click(); await page.getByRole('option', { name: 'Target person', exact: true }).click();
  await save(dialog); await expect(dialog).toBeHidden(); await expect(activeTab(page)).toContainText('人');
  const profile = info.project.use.isMobile ? page.getByRole('dialog', { name: 'Target person', exact: true }) : page.getByRole('article', { name: 'Target personのプロフィール', exact: true });
  await expect(profile).toContainText('Exact target owner'); await expect(profile).toContainText('Created voice');
  expect(api.state.data.accounts.find(a => a.label === 'Created voice').personId).toBe('target');
  await expect(query(page)).toHaveValue('  Target person  '); await expect(service(page, 'X')).toHaveAttribute('aria-pressed', 'true');
  if (info.project.use.isMobile) {
    await profile.getByRole('button', { name: 'Close', exact: true }).click(); await expect(profile).toBeHidden();
    await page.getByRole('button', { name: 'Target personの記録を開く', exact: true }).click(); await expect(profile).toContainText('Created voice');
  }
});
test('503 keeps draft and filters without committing or changing tab', async ({ page }) => {
  const api = await start(page); await query(page).fill('No match'); await service(page, 'X').click();
  api.failure = { status: 503, json: { error: 'Synthetic save unavailable' } };
  const dialog = await editor(page); await save(dialog); await expect(dialog.getByRole('alert')).toContainText('Synthetic save unavailable');
  await expect(dialog.getByLabel('表示名', { exact: true })).toHaveValue('Created voice');
  await expect(query(page)).toHaveValue('No match'); await expect(service(page, 'X')).toHaveAttribute('aria-pressed', 'true');
  await expect(activeTab(page)).toContainText('人'); expect(api.posts).toHaveLength(1); expect(api.state.undo).toHaveLength(0);
});
test('pending save reveals only after response and commits once', async ({ page }) => {
  const api = await start(page); let release; api.pause = new Promise(resolve => { release = resolve; });
  const dialog = await editor(page); await save(dialog); await expect.poll(() => api.posts.length).toBe(1);
  await expect(dialog.getByRole('button', { name: '保存中…' })).toBeDisabled(); await expect(activeTab(page)).toContainText('人');
  expect(api.state.undo).toHaveLength(0); release(); await expect(dialog).toBeHidden(); await expect(createdRow(page)).toBeVisible();
  expect(api.posts).toHaveLength(1); expect(api.state.undo).toHaveLength(1);
});
test('explicit cancel discards only input and never changes filters or saves', async ({ page }) => {
  const api = await start(page); await query(page).fill('No match'); await service(page, 'X').click();
  const dialog = await editor(page); await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '入力を破棄する', exact: true }).click(); await expect(dialog).toBeHidden();
  await expect(query(page)).toHaveValue('No match'); await expect(service(page, 'X')).toHaveAttribute('aria-pressed', 'true');
  await expect(activeTab(page)).toContainText('人'); expect(api.posts).toHaveLength(0); expect(api.state.undo).toHaveLength(0);
});
test('existing account edit retains old tab and now-hiding query', async ({ page }) => {
  const api = await start(page); await page.getByRole('tab', { name: /^未整理/ }).click(); await query(page).fill('Old unlinked'); await service(page, 'X').click();
  await page.getByRole('button', { name: 'Old unlinkedを編集', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'アカウントを編集', exact: true }); await dialog.getByLabel('表示名', { exact: true }).fill('Edited existing');
  await save(dialog); await expect(dialog).toBeHidden(); await expect(query(page)).toHaveValue('Old unlinked'); await expect(activeTab(page)).toContainText('未整理');
  expect(api.posts).toHaveLength(1); expect(api.state.data.accounts).toHaveLength(2); expect(api.state.data.accounts.find(a => a.id === 'old-unlinked').label).toBe('Edited existing');
});
test('two explicit additions produce two distinct records with no hidden retry', async ({ page }) => {
  const api = await start(page);
  for (let i = 0; i < 2; i++) { const dialog = await editor(page); await save(dialog); await expect(dialog).toBeHidden(); }
  expect(api.posts).toHaveLength(2); expect(api.state.undo).toHaveLength(2);
  const created = api.state.data.accounts.filter(a => a.label === 'Created voice'); expect(created).toHaveLength(2); expect(new Set(created.map(a => a.id)).size).toBe(2);
  await expect(createdRow(page)).toHaveCount(2);
});

// Long synthetic records expose viewport regressions that DOM visibility alone
// cannot detect. No scrolling/focusing from the test after save is permitted.
for (const linked of [false, true]) test(`new ${linked ? 'linked' : 'unlinked'} account is revealed in a long viewport`, async ({ page }, info) => {
  const data = fixture();
  data.people[1].notes = Array.from({ length: 35 }, (_, i) => `Synthetic note line ${i}`).join('\n');
  data.accounts.push(...Array.from({ length: 25 }, (_, i) => ({
    id: `long-${i}`, service: 'X', label: `Synthetic previous ${i}`,
    personId: linked ? 'target' : null, url: `https://x.com/synthetic_${i}`, key: `X:synthetic_${i}`,
  })));
  const api = await start(page, data); const dialog = await editor(page);
  if (linked) {
    await dialog.getByRole('combobox', { name: 'アカウントの紐づけ先' }).click();
    await page.getByRole('option', { name: 'Target person', exact: true }).click();
  }
  await save(dialog); await expect(dialog).toBeHidden();
  await expect(createdRow(page)).toBeInViewport({ ratio: 0.8 });
  await expect(createdRow(page)).toBeFocused();
  const focus = page.locator(':focus'); await expect(focus).toBeVisible();
  await expect(focus).not.toHaveJSProperty('tagName', 'BODY');
  await expect(focus).toBeInViewport();
  expect(api.posts).toHaveLength(1); expect(api.state.undo).toHaveLength(1);
  await page.screenshot({ path: `test-results/new-account/${info.project.name}-${linked ? 'linked' : 'unlinked'}-long.png`, fullPage: false });
});

test('accepted save while its modal is gated resumes row reveal after same-owner verification', async ({ page }) => {
  const data = fixture();
  data.accounts.push(...Array.from({ length: 25 }, (_, i) => ({ id: `pending-${i}`, service: 'X', label: `Pending previous ${i}`, personId: null, url: `https://x.com/pending_${i}`, key: `X:pending_${i}` })));
  const api = await start(page, data); let saveDone, checkDone;
  api.pause = new Promise(resolve => { saveDone = resolve; });
  const dialog = await editor(page); await save(dialog); await expect.poll(() => api.posts.length).toBe(1);
  api.sessionPause = new Promise(resolve => { checkDone = resolve; });
  const callsBefore = api.sessionCalls; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => api.sessionCalls).toBeGreaterThan(callsBefore);
  await expect(page.getByText('ログインを確認しています…', { exact: true })).toBeVisible();
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/records') && response.request().method() === 'POST');
  saveDone(); await (await accepted).finished(); await expect.poll(() => api.state.undo.length).toBe(1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  checkDone(); await expect(createdRow(page)).toBeInViewport({ ratio: 0.8 }); await expect(createdRow(page)).toBeFocused();
  expect(api.posts).toHaveLength(1); expect(api.state.undo).toHaveLength(1);
});
