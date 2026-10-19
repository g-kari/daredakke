import { test, expect } from '@playwright/test';
const namespace = 'u_' + 'b'.repeat(64);
for (const failure of ['allocate', 'click']) test(`export ${failure} exception preserves JSON and permits explicit retry`, async ({ page }) => {
  // ExportedAt is regenerated for each render/copy. Fix wall time without
  // freezing timers so exact JSON assertions and delayed URL cleanup coexist.
  await page.clock.setFixedTime(new Date('2026-10-19T00:00:00Z'));
  const errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.context().route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4317') { errors.push('Unexpected external request'); return route.abort(); }
    if (url.pathname === '/api/session') return route.fulfill({ json: { namespace } });
    if (url.pathname === '/api/records') {
      if (request.method() !== 'GET') { posts.push(request.method()); return route.abort(); }
      return route.fulfill({ json: { namespace, revision: 1, state: { data: { people: [], accounts: [] }, undo: [] } } });
    }
    return route.continue();
  });
  await page.goto('/'); await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'JSONを書き出す', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JSONを書き出す', exact: true });
  const json = dialog.getByRole('textbox', { name: '書き出しJSON' }), original = await json.inputValue();
  await page.evaluate(kind => {
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL), click = HTMLAnchorElement.prototype.click;
    window.exportProbe = { allocated: [], revoked: [], copied: [], fail: true };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.exportProbe.copied.push(text); } } });
    URL.createObjectURL = blob => { if (kind === 'allocate' && window.exportProbe.fail) throw Error('PRIVATE synthetic detail'); const url = create(blob); window.exportProbe.allocated.push(url); return url; };
    URL.revokeObjectURL = url => { window.exportProbe.revoked.push(url); revoke(url); };
    HTMLAnchorElement.prototype.click = function () { if (kind === 'click' && window.exportProbe.fail) throw Error('PRIVATE synthetic detail'); return click.call(this); };
  }, failure);
  await dialog.getByRole('button', { name: 'ファイルを保存', exact: true }).click();
  await expect(page.getByText('ファイル保存を開始できませんでした。もう一度試すか、JSONをコピーして安全に保管してください', { exact: true })).toBeVisible();
  await expect(json).toHaveValue(original); await expect(dialog.getByRole('button', { name: 'コピー', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'コピー', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.exportProbe.copied)).toEqual([original]);
  await expect(dialog.getByRole('button', { name: 'コピー済み', exact: true })).toBeVisible();
  if (failure === 'click') await expect.poll(() => page.evaluate(() => window.exportProbe.revoked.length)).toBe(1);
  await page.evaluate(() => { window.exportProbe.fail = false; });
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'ファイルを保存', exact: true }).click();
  const download = await downloadPromise; expect(download.suggestedFilename()).toMatch(/^daredakke-demo-\d{4}-\d{2}-\d{2}\.json$/);
  expect(await download.failure()).toBeNull();
  await expect.poll(() => page.evaluate(() => window.exportProbe.revoked.length)).toBe(failure === 'click' ? 2 : 1);
  await expect(json).toHaveValue(original); expect(errors).toEqual([]); expect(posts).toEqual([]);
});
