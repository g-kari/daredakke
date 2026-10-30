import { test, expect } from '@playwright/test';
const namespace = 'u_' + 'a'.repeat(64);
// Preserve the two five-second application-time checks without spending five
// real seconds idle. runFor fires every due timer; native animation and network
// still use ordinary actionability, and the actual toast must fully disappear.
async function letErrorToastExpire(page) {
  const toast = page.locator('[data-sonner-toast][data-type="error"]');
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute('data-mounted', 'true');
  await expect(toast).toHaveAttribute('data-visible', 'true');
  await page.mouse.move(0, 0);
  await expect(toast).toHaveAttribute('data-expanded', 'false');
  const before = await page.evaluate(() => Date.now());
  await page.clock.runFor(5000);
  expect(await page.evaluate(() => Date.now()) - before).toBeGreaterThanOrEqual(5000);
  await expect(toast).toHaveCount(0);
}
for (const length of [80, 81, 100]) test(`merge name ${length} respects the existing alias limit before confirmation`, async ({ page }, info) => {
  const sourceName = '名'.repeat(length), person = (id, name) => ({ id, name, aliases: [], tags: [], notes: '', color: '#4f5fcb' });
  const api = { state: { data: { people: [person('target', '統合先'), person('source', sourceName)], accounts: ['target', 'source'].map((personId, i) => ({ id: 'account' + i, service: 'X', label: 'synthetic', key: 'X:synthetic', url: 'https://x.com/synthetic', personId })) }, undo: [] }, posts: [], errors: [], violations: [] };
  const initial = JSON.stringify(api.state);
  page.on('pageerror', error => api.errors.push(error.message));
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4317') { api.violations.push(request.url()); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/session' && request.method() === 'GET') return route.fulfill({ json: { namespace } });
    if (url.pathname === '/api/records') {
      if (request.method() === 'GET') return route.fulfill({ json: { namespace, revision: 0, state: api.state } });
      if (request.method() === 'POST' && length === 80) { const body = request.postDataJSON(); api.posts.push(body); api.state = body.state; return route.fulfill({ json: { revision: 1 } }); }
    }
    api.violations.push(`${request.method()} ${url.pathname}`); return route.abort();
  });
  if (length > 80) await page.clock.install();
  await page.goto('/'); await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '統合先の記録を開く', exact: true }).click();
  const profile = info.project.use.isMobile ? page.getByRole('dialog', { name: '統合先', exact: true }) : page.getByRole('article', { name: '統合先のプロフィール' });
  await profile.locator('.record-maintenance>summary').click();
  await profile.getByRole('combobox', { name: '統合する別の人' }).click();
  await page.getByRole('option', { name: sourceName, exact: true }).click();
  await profile.getByRole('button', { name: 'この人に統合する', exact: true }).click();
  if (length === 80) {
    const alert = page.getByRole('alertdialog'); await expect(alert).toBeVisible(); expect(api.posts).toHaveLength(0);
    await alert.getByRole('button', { name: 'キャンセル', exact: true }).click(); expect(api.posts).toHaveLength(0); expect(JSON.stringify(api.state)).toBe(initial);
    await profile.getByRole('button', { name: 'この人に統合する', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: '統合する', exact: true }).click();
    await expect.poll(() => api.posts.length).toBe(1); await expect(page.getByText('保存済み', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: sourceName + 'の記録を開く', exact: true })).toHaveCount(0); expect(api.state.data.people).toHaveLength(1); expect(api.state.data.people[0].aliases).toEqual([sourceName]);
  } else {
    await expect(profile.getByRole('alert').filter({ hasText: '統合元の名前は別名として引き継ぐため80文字までです。名前を短くしてから、もう一度統合してください。' })).toBeVisible();
    await expect(profile.getByRole('button', { name: 'この人に統合する', exact: true })).toHaveAccessibleDescription(/80文字/);
    await letErrorToastExpire(page);
    await expect(profile.getByRole('alert')).toBeVisible();
    await profile.getByRole('combobox', { name: '統合する別の人' }).click();
    await page.getByRole('option', { name: '統合する人を選ぶ', exact: true }).click();
    await expect(profile.getByRole('alert')).toHaveCount(0);
    if (info.project.use.isMobile) await profile.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('tab', { name: /重複候補/ }).click();
    const duplicates = page.getByRole('tabpanel');
    await duplicates.getByRole('button', { name: 'この2人を統合', exact: true }).click();
    await expect(duplicates.getByRole('alert')).toHaveText(/80文字/);
    await expect(duplicates.getByRole('button', { name: 'この2人を統合', exact: true })).toHaveAccessibleDescription(/80文字/);
    await letErrorToastExpire(page);
    await expect(duplicates.getByRole('alert')).toBeVisible();
    await page.getByRole('tab', { name: '保存・バックアップ', exact: true }).click();
    await page.getByRole('tab', { name: /重複候補/ }).click();
    await expect(page.getByRole('tabpanel').getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0); expect(api.posts).toHaveLength(0); expect(JSON.stringify(api.state)).toBe(initial);
  }
  expect(api.errors).toEqual([]); expect(api.violations).toEqual([]);
});
