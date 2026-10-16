import { test, expect } from '@playwright/test';
const namespace = 'u_' + 'a'.repeat(64);
for (const length of [80, 81, 100]) test(`merge name ${length} respects the existing alias limit before confirmation`, async ({ page }, info) => {
  const sourceName = '名'.repeat(length), person = (id, name) => ({ id, name, aliases: [], tags: [], notes: '', color: '#4f5fcb' });
  const api = { state: { data: { people: [person('target', '統合先'), person('source', sourceName)], accounts: [] }, undo: [] }, posts: [], errors: [], violations: [] };
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
    await expect.poll(() => api.posts.length).toBe(1); expect(api.state.data.people).toHaveLength(1); expect(api.state.data.people[0].aliases).toEqual([sourceName]);
  } else {
    await expect(page.getByText('統合元の名前は別名として引き継ぐため80文字までです。名前を短くしてから、もう一度統合してください。', { exact: true })).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0); expect(api.posts).toHaveLength(0); expect(JSON.stringify(api.state)).toBe(initial);
  }
  expect(api.errors).toEqual([]); expect(api.violations).toEqual([]);
});
