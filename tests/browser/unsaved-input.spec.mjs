import { test, expect } from '@playwright/test';

const namespaceA = 'u_' + 'a'.repeat(64), namespaceB = 'u_' + 'b'.repeat(64);
const blank = () => ({ people: [], accounts: [] });

async function start(page, data = blank()) {
  const api = { namespace: namespaceA, revision: 0, state: { data, undo: [] }, posts: [], errors: [], tools: [] };
  page.on('pageerror', error => api.errors.push(error.message));
  await page.addInitScript(() => {
    window.__daredakkeTools = new Map();
    Object.defineProperty(document, 'modelContext', { configurable: true, value: {
      registerTool(tool) { window.__daredakkeTools.set(tool.name, tool); },
    } });
  });
  // The fixture uses the actual built UI. Every API response is synthetic and
  // every non-local request is blocked; no Access session or service is used.
  await page.context().route('**/*', route => {
    if (new URL(route.request().url()).origin === 'http://127.0.0.1:4317') return route.continue();
    api.errors.push('Unexpected non-local request'); return route.abort();
  });
  await page.context().route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4317') { api.errors.push('Unexpected non-local API request'); return route.abort(); }
    if (url.pathname === '/api/session') return route.fulfill({ json: { namespace: api.namespace } });
    if (url.pathname !== '/api/records') throw new Error('Unexpected API request: ' + url.pathname);
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); api.posts.push(body);
      api.state = body.state; api.revision++;
      return route.fulfill({ json: { revision: api.revision } });
    }
    return route.fulfill({ json: { namespace: api.namespace, revision: api.revision, state: api.state } });
  });
  await page.goto('/'); await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  return api;
}
const form = page => page.getByRole('dialog');
const alert = page => page.getByRole('alertdialog');
async function person(page) {
  await page.getByRole('button', { name: '人を追加', exact: true }).first().click();
  await form(page).getByLabel('名前 必須', { exact: true }).fill('Synthetic friend');
  await form(page).getByRole('textbox', { name: 'メモ', exact: true }).fill('Unsaved synthetic note');
}
async function dismiss(page, method) {
  if (method === 'Escape') await page.keyboard.press('Escape');
  else if (method === 'Backdrop') {
    if (test.info().project.use.hasTouch) await page.touchscreen.tap(10, 10);
    else await page.mouse.click(10, 10);
  }
  else await form(page).getByRole('button', { name: method, exact: true }).click();
  await expect(alert(page)).toBeVisible();
  await expect(alert(page).getByRole('button', { name: '編集を続ける', exact: true })).toBeFocused();
}
async function keep(page) {
  await alert(page).getByRole('button', { name: '編集を続ける', exact: true }).click();
  await expect(alert(page)).toHaveCount(0);
}
async function discard(page) {
  await alert(page).getByRole('button', { name: '入力を破棄する', exact: true }).click();
  await expect(alert(page)).toHaveCount(0); await expect(form(page)).toHaveCount(0);
}

test('Escape, Cancel, Close and backdrop preserve person input and return keyboard focus', async ({ page }, info) => {
  const api = await start(page); await person(page);
  for (const method of ['Escape', 'キャンセル', 'Close', 'Backdrop']) {
    const original = await page.evaluate(() => {
      const active = document.activeElement;
      return active?.tagName === 'TEXTAREA' ? 'notes' : active?.textContent;
    });
    await dismiss(page, method);
    if (method === 'Escape') await info.attach('discard-confirmation', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    await keep(page);
    await expect(form(page).getByRole('textbox', { name: 'メモ', exact: true })).toHaveValue('Unsaved synthetic note');
    // Escape/backdrop should restore the previously focused form control.
    if (method === 'Escape' || method === 'Backdrop') {
      expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
      if (original === 'notes') await expect(form(page).getByRole('textbox', { name: 'メモ', exact: true })).toBeFocused();
    }
  }
  expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('Escape in the discard alert keeps editing; explicit discard clears, unchanged forms close directly', async ({ page }) => {
  const api = await start(page); await person(page); await dismiss(page, 'Escape');
  await page.keyboard.press('Escape'); await expect(alert(page)).toHaveCount(0);
  await expect(form(page).getByLabel('名前 必須', { exact: true })).toHaveValue('Synthetic friend');
  await expect(form(page).getByRole('textbox', { name: 'メモ', exact: true })).toBeFocused();
  await dismiss(page, 'キャンセル'); await discard(page);
  await page.getByRole('button', { name: '人を追加', exact: true }).first().click();
  await expect(form(page).getByLabel('名前 必須', { exact: true })).toHaveValue('');
  await form(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(form(page)).toHaveCount(0); await expect(alert(page)).toHaveCount(0);
  expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('account edits survive repeated dismissal and still save normally', async ({ page }) => {
  const api = await start(page);
  await page.getByRole('button', { name: 'アカウント', exact: true }).click();
  await form(page).getByLabel('表示名', { exact: true }).fill('Synthetic account');
  await form(page).getByLabel('プロフィールURL / ID 必須', { exact: true }).fill('100000000000000001');
  for (const method of ['Escape', 'キャンセル', 'Close', 'Backdrop']) {
    await dismiss(page, method); await keep(page);
    await expect(form(page).getByLabel('表示名', { exact: true })).toHaveValue('Synthetic account');
    await expect(form(page).getByLabel('プロフィールURL / ID 必須', { exact: true })).toHaveValue('100000000000000001');
  }
  await form(page).getByRole('button', { name: '保存する', exact: true }).click();
  await expect(form(page)).toHaveCount(0); expect(api.posts).toHaveLength(1);
  expect(api.state.data.accounts[0].label).toBe('Synthetic account');
  let unexpected = false;
  page.once('dialog', async dialog => { unexpected = true; await dialog.dismiss(); });
  await page.reload(); await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  expect(unexpected).toBe(false); expect(api.errors).toEqual([]);
});

test('staged import JSON survives cancellation and explicit discard clears it', async ({ page }) => {
  const api = await start(page); const json = JSON.stringify({ format: 'daredakke', version: 1, data: blank() });
  await page.getByRole('tab', { name: '連携・保存' }).click();
  await page.getByRole('button', { name: 'JSONを読み込む', exact: true }).click();
  await form(page).getByRole('textbox', { name: 'JSON', exact: true }).fill(json);
  for (const method of ['Close', 'Escape', 'Backdrop']) {
    await dismiss(page, method); await keep(page); await expect(form(page).getByRole('textbox', { name: 'JSON', exact: true })).toHaveValue(json);
  }
  await dismiss(page, 'Escape'); await discard(page);
  await page.getByRole('button', { name: 'JSONを読み込む', exact: true }).click();
  await expect(form(page).getByRole('textbox', { name: 'JSON', exact: true })).toHaveValue('');
  await page.keyboard.press('Escape'); await expect(form(page)).toHaveCount(0); await expect(alert(page)).toHaveCount(0);
  expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('repeated WebMCP creation requests protect the latest draft and original focus', async ({ page }) => {
  const api = await start(page); await person(page);
  await page.evaluate(() => window.__daredakkeTools.get('start_person_creation').execute({}));
  await expect(alert(page)).toBeVisible();
  await page.evaluate(() => window.__daredakkeTools.get('start_person_creation').execute({}));
  await keep(page);
  await expect(form(page).getByRole('textbox', { name: 'メモ', exact: true })).toHaveValue('Unsaved synthetic note');
  await expect(form(page).getByRole('textbox', { name: 'メモ', exact: true })).toBeFocused();
  await page.evaluate(() => window.__daredakkeTools.get('start_person_creation').execute({}));
  await page.evaluate(() => window.__daredakkeTools.get('start_person_creation').execute({}));
  await page.keyboard.press('Escape'); await expect(alert(page)).toHaveCount(0);
  await expect(form(page).getByRole('textbox', { name: 'メモ', exact: true })).toBeFocused();
  expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('identity change clears draft and pending discard instead of retaining another session input', async ({ page }) => {
  const api = await start(page); await person(page); await dismiss(page, 'Escape');
  api.namespace = namespaceB;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert').filter({ hasText: 'ログイン' })).toBeVisible();
  await expect(form(page)).toHaveCount(0); await expect(alert(page)).toHaveCount(0);
  expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('discard confirmation fits the viewport and traps keyboard focus in the safe action', async ({ page }) => {
  const api = await start(page); await person(page); await dismiss(page, 'Escape');
  const viewport = page.viewportSize(), bounds = await alert(page).boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('[role="alertdialog"]') !== null)).toBe(true);
  await page.keyboard.press('Tab');
  await expect(alert(page).getByRole('button', { name: '編集を続ける', exact: true })).toBeFocused();
  expect(api.errors).toEqual([]);
});


test('editing from the person Sheet preserves the note and nested-modal focus', async ({ page }) => {
  const data = { people: [{ id: 'synthetic-person', name: 'Synthetic saved friend', aliases: ['Fixture'], tags: ['test'], notes: 'Saved synthetic note', color: '#4f5fcb' }], accounts: [] };
  const api = await start(page, data);
  await page.getByRole('button', { name: 'Synthetic saved friendの記録を開く', exact: true }).click();
  await form(page).getByRole('button', { name: '編集', exact: true }).click();
  await form(page).getByRole('textbox', { name: 'メモ', exact: true }).fill('Edited synthetic note');
  await dismiss(page, 'Escape'); await keep(page);
  await expect(form(page).getByRole('textbox', { name: 'メモ', exact: true })).toHaveValue('Edited synthetic note');
  await expect(form(page).getByRole('textbox', { name: 'メモ', exact: true })).toBeFocused();
  await dismiss(page, 'キャンセル');
  await alert(page).getByRole('button', { name: '入力を破棄する', exact: true }).click();
  await expect(alert(page)).toHaveCount(0);
  await expect(form(page).getByText('Saved synthetic note', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(form(page)).toHaveCount(0);
  expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('page reload warns only while unsaved input remains and cancellation preserves fields', async ({ page }) => {
  const api = await start(page); await person(page);
  const originalUrl = page.url(), waiting = page.waitForEvent('dialog');
  // A dismissed beforeunload intentionally prevents navigation. Trigger native
  // reload without a Playwright navigation waiter that can never reach 'load'.
  await page.evaluate(() => { window.setTimeout(() => window.location.reload(), 0); });
  const native = await waiting;
  expect(native.type()).toBe('beforeunload');
  await native.dismiss();
  await expect(page).toHaveURL(originalUrl);
  await expect(form(page).getByRole('textbox', { name: 'メモ', exact: true })).toHaveValue('Unsaved synthetic note');
  await dismiss(page, 'Escape'); await discard(page);
  let unexpected = false;
  page.once('dialog', async dialog => { unexpected = true; await dialog.dismiss(); });
  await page.reload(); await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  expect(unexpected).toBe(false); expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});


test('reverting all person fields to their initial values removes the navigation warning', async ({ page }) => {
  const api = await start(page); await person(page);
  await form(page).getByLabel('名前 必須', { exact: true }).fill('');
  await form(page).getByRole('textbox', { name: 'メモ', exact: true }).fill('');
  let unexpected = false;
  page.once('dialog', async dialog => { unexpected = true; await dialog.dismiss(); });
  await page.reload(); await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  expect(unexpected).toBe(false); expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});
