import { test, expect } from '@playwright/test';
const noChangeText = '変更はありません。記録と復元履歴はそのままです。編集を続けるか、キャンセルで閉じてください。';
const namespace = 'u_' + 'a'.repeat(64);
const fixture = () => ({ people: [{ id: 'synthetic-person', name: 'Synthetic person', aliases: ['Alias one', 'Alias two'], tags: ['one', 'two'], notes: 'Original recovery note', color: '#4f5fcb' }], accounts: [{ id: 'synthetic-account', service: 'Discord', label: 'Synthetic account', url: 'https://discord.com/users/100000000000000001', key: 'Discord:100000000000000001', personId: null }] });
async function start(page) {
  const before = fixture(), after = structuredClone(before); after.people[0].notes = 'Meaningful edited note';
  const api = { before, state: { data: after, undo: [{ label: 'Meaningful synthetic edit', at: '2026-10-18T00:00:00Z', data: before }] }, revision: 1, posts: [], errors: [], fail: false };
  page.on('pageerror', e => api.errors.push(e.message));
  await page.context().route('**/*', route => {
    if (new URL(route.request().url()).origin === 'http://127.0.0.1:4317') return route.continue();
    api.errors.push('Unexpected non-local request'); return route.abort();
  });
  await page.context().route('**/api/**', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4317') throw new Error('Unexpected origin');
    if (url.pathname === '/api/session' && request.method() === 'GET') return route.fulfill({ json: { namespace } });
    if (url.pathname !== '/api/records') throw new Error('Unexpected API');
    if (request.method() === 'GET') return route.fulfill({ json: { namespace, revision: api.revision, state: api.state } });
    if (request.method() !== 'POST') throw new Error('Unexpected mutation');
    const body = request.postDataJSON(); api.posts.push(body);
    expect(body.expectedNamespace).toBe(namespace); expect(body.revision).toBe(api.revision);
    if (api.fail) return route.fulfill({ status: 500, json: { error: 'Synthetic save failed' } });
    api.state = body.state; api.revision++;
    return route.fulfill({ json: { revision: api.revision } });
  });
  await page.goto('/'); await expect(page.getByText('保存済み', { exact: true })).toBeVisible(); return api;
}
const personProfile = (page, info) => info.project.use.isMobile ? page.getByRole('dialog', { name: 'Synthetic person', exact: true }) : page.getByRole('article', { name: 'Synthetic personのプロフィール', exact: true });
async function openPerson(page, info) {
  if (info.project.use.isMobile && await personProfile(page, info).count()) return personProfile(page, info);
  await page.getByRole('button', { name: 'Synthetic personの記録を開く', exact: true }).click();
  return personProfile(page, info);
}
const editor = page => page.getByRole('dialog', { name: /人の記録を編集|アカウントを編集/ });
for (const kind of ['person', 'account']) test(`ten unchanged ${kind} saves preserve meaningful undo without POST`, async ({ page }, info) => {
  const api = await start(page), initial = structuredClone(api.state);
  if (kind === 'person') await openPerson(page, info);
  else await page.getByRole('tab', { name: /^未整理/ }).click();
  if (kind === 'person') await personProfile(page, info).getByRole('button', { name: '編集', exact: true }).click();
  else await page.getByRole('button', { name: 'Synthetic accountを編集', exact: true }).click();
  for (let repeat = 0; repeat < 10; repeat++) {
    await editor(page).getByRole('button', { name: '保存する', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(editor(page)).toBeVisible();
    await expect(editor(page).getByRole('status')).toHaveText(noChangeText);
    await expect(editor(page).getByRole('status')).toBeInViewport({ ratio: 1 });
    expect(api.posts).toHaveLength(0); expect(api.state).toEqual(initial);
    if (repeat === 0) await info.attach(`unchanged-${kind}`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  }
  const field = kind === 'person' ? editor(page).getByRole('textbox', { name: 'メモ', exact: true }) : editor(page).getByLabel('表示名', { exact: true });
  const original = await field.inputValue();
  await field.fill(original + ' temporary'); await expect(editor(page).getByRole('status')).toHaveText('');
  await field.fill(original);
  await editor(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  if (kind === 'person' && info.project.use.isMobile) {
    await personProfile(page, info).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(personProfile(page, info)).toHaveCount(0);
  }
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect.poll(() => api.posts.length).toBe(1);
  expect(api.state.data).toEqual(api.before); expect(api.state.undo).toEqual([]);
  await expect(page.getByRole('button', { name: '元に戻す', exact: true })).toBeDisabled();
  expect(api.errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
test('canonical unchanged fields do not save; a real edit fails safely then explicitly saves and undoes', async ({ page }, info) => {
  const api = await start(page), initial = structuredClone(api.state);
  const profile = await openPerson(page, info);
  await profile.getByRole('button', { name: '編集', exact: true }).click();
  await editor(page).getByLabel('名前 必須', { exact: true }).fill('  Synthetic person  ');
  await editor(page).getByRole('button', { name: '保存する', exact: true }).click();
  await expect(editor(page).getByRole('status')).toHaveText(noChangeText); expect(api.posts).toHaveLength(0); expect(api.state).toEqual(initial);
  await editor(page).getByRole('textbox', { name: 'メモ', exact: true }).fill('A real new synthetic note');
  await expect(editor(page).getByRole('status')).toHaveText('');
  api.fail = true;
  await editor(page).getByRole('button', { name: '保存する', exact: true }).click();
  await expect(editor(page).getByRole('alert')).toHaveText('Synthetic save failed');
  await expect(editor(page).getByRole('textbox', { name: 'メモ', exact: true })).toHaveValue('A real new synthetic note');
  expect(api.posts).toHaveLength(1); expect(api.state).toEqual(initial);
  api.fail = false;
  await editor(page).getByRole('button', { name: '保存する', exact: true }).click();
  await expect(editor(page)).toHaveCount(0); expect(api.posts).toHaveLength(2);
  expect(api.state.data.people[0].notes).toBe('A real new synthetic note'); expect(api.state.undo).toHaveLength(2);
  if (info.project.use.isMobile) {
    await personProfile(page, info).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(personProfile(page, info)).toHaveCount(0);
  }
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect.poll(() => api.posts.length).toBe(3); expect(api.state).toEqual(initial); expect(api.errors).toEqual([]);
});
