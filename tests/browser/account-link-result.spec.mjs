import { test, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:4317', namespace = 'u_' + 'a'.repeat(64);
const fixtures = new WeakMap();
const fixture = () => ({ people: [
  { id: 'source', name: 'Source person', aliases: [], tags: [], notes: 'Source unchanged', color: '#4f5fcb' },
  { id: 'target', name: 'Target person', aliases: [], tags: [], notes: 'Exact destination', color: '#147d89' },
], accounts: [
  { id: 'source-voice', service: 'Discord', label: 'Moving voice', personId: 'source', url: 'https://discord.com/users/100000000000000001', key: 'Discord:100000000000000001' },
  { id: 'loose-voice', service: 'Discord', label: 'Loose voice', personId: null, url: 'https://discord.com/users/100000000000000002', key: 'Discord:100000000000000002' },
  { id: 'target-x', service: 'X', label: 'Target existing X', personId: 'target', url: 'https://x.com/target_fixture', key: 'X:target_fixture' },
] });
const query = page => page.locator('input[aria-label="記録を検索"]');
const service = (page, name) => page.locator('.service-filter').filter({ hasText: name });
const result = page => page.getByRole('status', { name: 'アカウントの移動結果', exact: true });
const row = (page, label) => page.locator('.account-row').filter({ hasText: label });
const activeTab = page => page.locator('[role="tab"][data-state="active"]');
async function start(page) {
  const api = { state: { data: fixture(), undo: [] }, revision: 0, personal: { state: { data: { people: [], accounts: [] }, undo: [] }, revision: 0 }, posts: [], errors: [], denied: [], failure: null, pause: null, sessionNamespace: namespace };
  fixtures.set(page, api); page.on('pageerror', error => api.errors.push(error.message));
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const deny = reason => { api.denied.push(reason); return route.abort(); };
    if (url.origin !== origin) return deny('external request');
    if (!url.pathname.startsWith('/api/')) return request.method() === 'GET' ? route.continue() : deny('non-GET asset');
    if (url.pathname === '/api/session' && !url.search && request.method() === 'GET') return route.fulfill({ json: { namespace: api.sessionNamespace } });
    if (url.pathname !== '/api/records') return deny('unexpected API');
    if (request.method() === 'GET' && url.searchParams.size === 1 && ['demo', 'personal'].includes(url.searchParams.get('scope'))) {
      const stored = url.searchParams.get('scope') === 'demo' ? api : api.personal;
      return route.fulfill({ json: { namespace, state: stored.state, revision: stored.revision } });
    }
    if (request.method() !== 'POST' || url.search) return deny('unexpected method/query');
    const body = request.postDataJSON(); api.posts.push(body);
    if (body.scope !== 'demo' || body.expectedNamespace !== namespace || body.revision !== api.revision || request.headers()['x-friend-record'] !== '1') return deny('invalid write context');
    if (api.pause) { const gate = api.pause; api.pause = null; await gate; }
    if (api.failure) return route.fulfill(api.failure);
    api.state = structuredClone(body.state); api.revision++;
    return route.fulfill({ json: { revision: api.revision } });
  });
  await page.goto('/'); await expect(page.getByText('保存済み', { exact: true })).toBeVisible(); return api;
}
async function relink(page, label, destination) {
  const account = row(page, label);
  const summary = account.locator('summary');
  // Only profile rows collapse their URL and relink controls in native details.
  if (await summary.count()) await summary.click();
  await account.getByRole('combobox', { name: `${label}の紐づけ先`, exact: true }).click();
  await page.getByRole('option', { name: destination, exact: true }).click();
}
async function looseList(page) { await page.getByRole('tab', { name: /^未整理/ }).click(); }
test.afterEach(async ({ page }) => { const api = fixtures.get(page); if (!api) return; expect(api.denied).toEqual([]); expect(api.errors).toEqual([]); });

test('relink stays in the organizer until explicit confirmation, then focuses exact destination', async ({ page }, info) => {
  const api = await start(page), raw = '  LOOSE\u3000voice  ';
  await query(page).fill(raw); await service(page, 'Discord').click(); await looseList(page);
  await relink(page, 'Loose voice', 'Target person');
  await expect(result(page)).toContainText('Loose voice'); await expect(result(page)).toContainText('Target person');
  await expect(activeTab(page)).toContainText('未整理'); await expect(query(page)).toHaveValue(raw);
  await expect(service(page, 'Discord')).toHaveAttribute('aria-pressed', 'true');
  expect(api.posts).toHaveLength(1); expect(api.state.undo).toHaveLength(1); expect(api.state.data.people).toEqual(fixture().people);
  await page.screenshot({ path: `test-results/account-link/${info.project.name}-result.png`, fullPage: false });
  await result(page).getByRole('button', { name: '移動先を確認', exact: true }).click();
  const profile = info.project.use.isMobile ? page.getByRole('dialog', { name: 'Target person', exact: true }) : page.getByRole('article', { name: 'Target personのプロフィール', exact: true });
  await expect(profile).toContainText('Exact destination'); await expect(row(page, 'Loose voice')).toBeFocused();
  await expect(row(page, 'Loose voice')).toBeInViewport({ ratio: 0.8 }); await expect(query(page)).toHaveValue(raw);
  expect(api.posts).toHaveLength(1); expect(api.state.undo).toHaveLength(1);
  if (info.project.use.isMobile) {
    await profile.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Target personの記録を開く', exact: true })).toBeFocused();
  }
});
test('profile unlink reports 未整理 inside mobile Sheet and waits for close before row focus', async ({ page }, info) => {
  const api = await start(page); await query(page).fill('  Source person  '); await service(page, 'Discord').click();
  await page.getByRole('button', { name: 'Source personの記録を開く', exact: true }).click();
  await relink(page, 'Moving voice', '未整理のまま'); await expect(result(page)).toContainText('未整理');
  await expect(activeTab(page)).toContainText('人'); await expect(query(page)).toHaveValue('  Source person  ');
  if (info.project.use.isMobile) await expect(page.getByRole('dialog', { name: 'Source person', exact: true }).getByRole('status', { name: 'アカウントの移動結果' })).toBeVisible();
  await result(page).getByRole('button', { name: '移動先を確認', exact: true }).click();
  if (info.project.use.isMobile) await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
  await expect(activeTab(page)).toContainText('未整理'); await expect(row(page, 'Moving voice')).toBeFocused();
  await expect(row(page, 'Moving voice')).toBeInViewport({ ratio: 0.8 }); await expect(query(page)).toHaveValue('');
  await expect(service(page, 'Discord')).toHaveAttribute('aria-pressed', 'true');
  expect(api.posts).toHaveLength(1); expect(api.state.undo).toHaveLength(1);
  await page.screenshot({ path: `test-results/account-link/${info.project.name}-unlink-focus.png`, fullPage: false });
});
test('pending and failed relink leave organizer and records intact, with explicit retry only', async ({ page }) => {
  const api = await start(page); await looseList(page); let finish;
  api.pause = new Promise(resolve => { finish = resolve; }); api.failure = { status: 503, json: { error: 'Synthetic save unavailable' } };
  await relink(page, 'Loose voice', 'Target person'); await expect.poll(() => api.posts.length).toBe(1);
  await expect(result(page)).toHaveCount(0); await expect(activeTab(page)).toContainText('未整理');
  expect(api.state.data).toEqual(fixture()); expect(api.state.undo).toHaveLength(0);
  finish(); await expect(page.locator('.error-banner')).toContainText('Synthetic save unavailable');
  await expect(result(page)).toHaveCount(0); await expect(row(page, 'Loose voice')).toBeVisible(); expect(api.posts).toHaveLength(1);
  api.failure = null; await relink(page, 'Loose voice', 'Target person');
  await expect(result(page)).toContainText('Target person'); expect(api.posts).toHaveLength(2); expect(api.state.undo).toHaveLength(1);
});
test('dismissal preserves saved data and later relink shows only its latest result', async ({ page }) => {
  const api = await start(page); await looseList(page); await relink(page, 'Loose voice', 'Target person');
  await expect(result(page)).toBeVisible(); const saved = structuredClone(api.state);
  await result(page).getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(result(page)).toHaveCount(0); expect(api.state).toEqual(saved); expect(api.posts).toHaveLength(1);
  await page.getByRole('tab', { name: /^人 / }).click();
  await page.getByRole('button', { name: 'Source personの記録を開く', exact: true }).click();
  await relink(page, 'Moving voice', 'Target person');
  await expect(result(page)).toContainText('Moving voice'); await expect(result(page)).not.toContainText('Loose voice');
  await expect(activeTab(page)).toContainText('人'); expect(api.posts).toHaveLength(2); expect(api.state.undo).toHaveLength(2);
});
test('undo removes stale result and restores exactly the original records', async ({ page }) => {
  const api = await start(page); await looseList(page); await relink(page, 'Loose voice', 'Target person');
  await expect(result(page)).toBeVisible(); await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(result(page)).toHaveCount(0); await expect(row(page, 'Loose voice')).toBeVisible();
  expect(api.state.data).toEqual(fixture()); expect(api.state.undo).toHaveLength(0); expect(api.posts).toHaveLength(2);
});
test('new unsaved input stays in its editor and does not open the prior destination', async ({ page }) => {
  const api = await start(page); await looseList(page); await relink(page, 'Loose voice', 'Target person'); await expect(result(page)).toBeVisible();
  await page.getByRole('button', { name: '人を追加', exact: true }).click(); const editor = page.getByRole('dialog', { name: '人を追加', exact: true });
  await editor.getByLabel('名前').fill('Unsaved person'); await page.keyboard.press('Escape');
  await page.getByRole('alertdialog').getByRole('button', { name: '編集を続ける', exact: true }).click();
  await expect(editor.getByLabel('名前')).toHaveValue('Unsaved person'); await expect(editor.getByLabel('名前')).toBeFocused();
  await expect(activeTab(page)).toContainText('未整理'); expect(api.posts).toHaveLength(1); expect(api.state.undo).toHaveLength(1);
});
test('scope change removes the prior result without changing either saved scope', async ({ page }) => {
  const api = await start(page); await looseList(page); await relink(page, 'Loose voice', 'Target person'); await expect(result(page)).toBeVisible();
  const saved = structuredClone(api.state); await page.getByRole('button', { name: 'マイレコード', exact: true }).click();
  await expect(page.getByRole('button', { name: 'マイレコード', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(result(page)).toHaveCount(0); await expect(page.getByRole('button', { name: 'Target personの記録を開く', exact: true })).toHaveCount(0);
  expect(api.state).toEqual(saved); expect(api.personal.state.data).toEqual({ people: [], accounts: [] }); expect(api.posts).toHaveLength(1);
});
test('changed session cannot display or use an old destination result', async ({ page }) => {
  const api = await start(page); await looseList(page); await relink(page, 'Loose voice', 'Target person'); await expect(result(page)).toBeVisible();
  api.sessionNamespace = 'u_' + 'b'.repeat(64); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.error-banner')).toContainText('ログインを確認できません');
  await expect(result(page)).toHaveCount(0); await expect(page.getByRole('button', { name: '移動先を確認', exact: true })).toHaveCount(0);
  expect(api.posts).toHaveLength(1);
});
