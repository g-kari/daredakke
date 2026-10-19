import { test, expect } from '@playwright/test';

async function start(page) {
  const violations = [];
  page.on('pageerror', error => violations.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4317' || request.method() !== 'GET') { violations.push(request.method() + ' ' + url.pathname); return route.abort(); }
    if (url.pathname === '/api/session') return route.fulfill({ json: { namespace: 'u_' + 'a'.repeat(64) } });
    if (url.pathname === '/api/records') return route.fulfill({ json: { namespace: 'u_' + 'a'.repeat(64), revision: 0, state: { data: { people: [ { id: 'synthetic', name: 'Synthetic person', aliases: [], tags: [], notes: 'Synthetic motion fixture only', color: '#4f5fcb' } ], accounts: [] }, undo: [] } } });
    if (url.pathname.startsWith('/api/')) { violations.push(url.pathname); return route.abort(); }
    return route.continue();
  });
  await page.goto('/');
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  return violations;
}

for (const reducedMotion of ['no-preference', 'reduce']) test(`person detail preserves navigation with ${reducedMotion}`, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion });
  const violations = await start(page);
  const opener = page.getByRole('button', { name: 'Synthetic personの記録を開く', exact: true });
  await opener.focus(); await page.keyboard.press('Enter');
  if (info.project.use.isMobile) {
    const sheet = page.getByRole('dialog', { name: 'Synthetic person', exact: true });
    await expect(sheet).toBeVisible();
    if (reducedMotion === 'reduce') expect(await sheet.evaluate(el => Math.abs(new DOMMatrix(getComputedStyle(el).transform).m41))).toBeLessThan(1);
    await expect(sheet).toHaveAttribute('data-side', 'right');
    await expect(sheet.getByText('Synthetic motion fixture only', { exact: true })).toBeVisible();
    await expect.poll(() => sheet.evaluate(el => Math.abs(new DOMMatrix(getComputedStyle(el).transform).m41))).toBeLessThan(1);
    await expect(sheet.getByRole('button', { name: 'Close', exact: true })).toBeInViewport({ ratio: 1 });
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); expect(await sheet.evaluate(el => el.contains(document.activeElement))).toBe(true); }
    await info.attach(`person-sheet-${reducedMotion}`, { body: await page.screenshot(), contentType: 'image/png' });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0); await expect(opener).toBeFocused();
    await page.keyboard.press('Enter'); await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0); await expect(opener).toBeFocused();
  } else {
    await expect(page.getByRole('article', { name: 'Synthetic personのプロフィール', exact: true })).toBeVisible();
    await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(violations).toEqual([]);
});
