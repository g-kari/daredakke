import { test, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:4317';
const namespaceA = 'u_' + 'a'.repeat(64);
const namespaceB = 'u_' + 'b'.repeat(64);
const empty = () => ({ people: [], accounts: [] });
const person = (id, name, notes = '') => ({ id, name, aliases: [], tags: [], notes, color: '#4f5fcb' });
const account = (id, handle, personId = null) => ({
  id, service: 'X', label: handle, url: 'https://x.com/' + handle, key: 'X:' + handle, personId,
});
const current = () => ({
  people: [person('person-update', '同じ名前', 'Before'), person('person-keep', 'Keep'), person('person-remove', '同じ名前')],
  accounts: [account('account-update', 'fixture_old', 'person-update'), account('account-keep', 'fixture_keep', 'person-keep'), account('account-remove', 'fixture_drop')],
});
const incoming = () => ({
  people: [person('person-update', '同じ名前', 'After'), person('person-keep', 'Keep'), person('person-add', '同じ名前')],
  accounts: [account('account-update', 'fixture_new'), account('account-keep', 'fixture_keep', 'person-keep'), account('account-add', 'fixture_keep')],
});
const jsonOf = (data = incoming(), format = 'daredakke', extra = {}) => JSON.stringify({ format, version: 1, data, ...extra });
const form = page => page.getByRole('dialog', { name: 'JSONを読み込む', exact: true });
const jsonInput = page => form(page).getByRole('textbox', { name: 'JSON', exact: true });
const review = page => form(page).getByRole('region', { name: '読み込み内容の確認', exact: true });
const alert = page => page.getByRole('alertdialog');
const reviewButton = page => form(page).getByRole('button', { name: '内容を確認して読み込む', exact: true });
const confirmButton = page => form(page).getByRole('button', { name: '置き換えを確認する', exact: true });
const finalButton = page => alert(page).getByRole('button', { name: '置き換えて読み込む', exact: true });
const acknowledgment = page => form(page).getByRole('checkbox', { name: 'この保存先の記録を空にすることを確認しました', exact: true });
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function start(page, options = {}) {
  const data = options.data ?? current();
  const api = {
    namespace: options.namespace ?? namespaceA,
    recordsNamespace: options.recordsNamespace ?? namespaceA,
    scopes: {
      demo: { revision: 0, state: { data: structuredClone(data), undo: [] } },
      personal: { revision: 0, state: { data: structuredClone(data), undo: [] } },
    },
    posts: [], errors: [], responses: [], sessionGate: null, postGate: null, sessionCompleted: 0,
  };
  page.on('pageerror', error => api.errors.push(error.message));
  await page.addInitScript(() => {
    // Delay only named synthetic files, without adding an application test API.
    const original = File.prototype.text;
    window.__syntheticFileReads = new Map();
    window.__syntheticFileHistory = [];
    File.prototype.text = function () {
      if (!this.name.startsWith('deferred-')) return original.call(this);
      return new Promise((resolve, reject) => {
        const read = { name: this.name, resolve, reject };
        window.__syntheticFileReads.set(this.name, read);
        window.__syntheticFileHistory.push(read);
      });
    };
  });
  await page.context().route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    api.errors.push('Unexpected non-local request');
    return route.abort();
  });
  await page.context().route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { api.errors.push('Unexpected non-local API request'); return route.abort(); }
    if (url.pathname === '/api/session') {
      if (api.sessionGate) await api.sessionGate.promise;
      api.sessionCompleted++; return route.fulfill({ json: { namespace: api.namespace } });
    }
    if (url.pathname !== '/api/records') throw new Error('Unexpected API request: ' + url.pathname);
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      api.posts.push(body);
      if (api.postGate) await api.postGate.promise;
      const response = api.responses.shift();
      if (response) return route.fulfill(response);
      const store = api.scopes[body.scope];
      if (!store) throw new Error('Unexpected record scope');
      store.state = body.state;
      store.revision++;
      return route.fulfill({ json: { revision: store.revision } });
    }
    const store = api.scopes[url.searchParams.get('scope')];
    if (!store) throw new Error('Unexpected record scope');
    return route.fulfill({ json: { namespace: api.recordsNamespace, ...store } });
  });
  await page.goto('/');
  if (options.loadError) await expect(page.getByRole('alert').filter({ hasText: 'ログイン' })).toBeVisible();
  else await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  return api;
}

async function open(page, text = jsonOf()) {
  await page.getByRole('button', { name: 'JSONを読み込む', exact: true }).click();
  await expect(form(page)).toBeVisible();
  if (text !== null) await jsonInput(page).fill(text);
}
async function stage(page) {
  await reviewButton(page).click();
  await expect(review(page)).toBeVisible();
  await expect(alert(page)).toHaveCount(0);
}
async function finalConfirmation(page) {
  await confirmButton(page).click();
  await expect(alert(page)).toBeVisible();
  await expect(finalButton(page)).toBeEnabled();
}
async function counts(page, name, values) {
  const section = review(page).getByRole('region', { name, exact: true });
  await expect(section).toBeVisible();
  for (const [label, value] of Object.entries(values)) {
    const term = section.locator('dt').filter({ hasText: new RegExp('^' + label + '$') });
    await expect(term).toHaveCount(1);
    await expect(term.locator('xpath=following-sibling::dd[1]')).toHaveText(value + '件');
  }
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await form(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  const bounds = await form(page).boundingBox(), viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
}
async function chooseFile(page, name, text = jsonOf()) {
  await page.getByLabel('JSONファイルを選択', { exact: true }).setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
}
async function waitForFile(page, name) {
  await expect.poll(() => page.evaluate(name => window.__syntheticFileReads.has(name), name)).toBe(true);
}
async function resolveFile(page, name, text) {
  await page.evaluate(({ name, text }) => window.__syntheticFileReads.get(name).resolve(text), { name, text });
}

test('preview shows exact-ID changes, replacement warnings and normalized unresolved/duplicate counts without saving', async ({ page }) => {
  const api = await start(page), text = jsonOf();
  await open(page, text); await stage(page);
  await expect(review(page).getByRole('heading', { name: '読み込み内容の確認', exact: true })).toBeVisible();
  await expect(review(page)).toContainText('貼り付けたJSON');
  await expect(review(page)).toContainText('daredakke');
  await expect(review(page)).toContainText(/version\s*1/);
  const expected = { '現在': 3, '読み込み後': 3, '追加': 1, '更新': 1, '取り除く': 1, '変更なし': 1 };
  await counts(page, '人の変更', expected);
  await counts(page, 'アカウントの変更', expected);
  await expect(review(page)).toContainText(/置き換/);
  await expect(review(page)).toContainText(/名前.*(?:推測|判定|同一人物)/);
  await expect(review(page)).toContainText(/未整理.*2/);
  await expect(review(page)).toContainText(/重複候補.*1/);
  await expect(jsonInput(page)).toHaveValue(text);
  await expect(jsonInput(page)).toBeVisible();
  expect(api.scopes.demo.state.data).toEqual(current());
  expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('reordered records and normalized URLs remain unchanged and legacy provenance is disclosed', async ({ page }) => {
  const api = await start(page), data = current();
  data.people.reverse(); data.accounts.reverse();
  data.accounts.forEach(item => { item.url = item.url.replace('x.com/', 'twitter.com/') + '?utm_source=synthetic'; item.key = 'untrusted-imported-key'; });
  await open(page, jsonOf(data, 'friend-record')); await stage(page);
  await expect(review(page)).toContainText('friend-record');
  const expected = { '現在': 3, '読み込み後': 3, '追加': 0, '更新': 0, '取り除く': 0, '変更なし': 3 };
  await counts(page, '人の変更', expected); await counts(page, 'アカウントの変更', expected);
  expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('back preserves JSON, edits invalidate the review, and blank edits cannot replace records', async ({ page }) => {
  const api = await start(page), first = jsonOf();
  await open(page, first); await stage(page);
  await form(page).getByRole('button', { name: 'JSONの編集に戻る', exact: true }).click();
  await expect(review(page)).toHaveCount(0); await expect(jsonInput(page)).toHaveValue(first);
  await expect(jsonInput(page)).toBeFocused();
  await stage(page);
  const changed = incoming(); changed.people[0].notes = 'Newest synthetic note';
  const second = jsonOf(changed);
  await jsonInput(page).fill(second);
  await expect(review(page)).toHaveCount(0); await expect(confirmButton(page)).toHaveCount(0);
  await stage(page); await expect(jsonInput(page)).toHaveValue(second);
  await jsonInput(page).fill('');
  await expect(review(page)).toHaveCount(0); await expect(reviewButton(page)).toBeDisabled();
  await expect(confirmButton(page)).toHaveCount(0);
  expect(api.scopes.demo.state.data).toEqual(current());
  expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('final cancellation and repeated dialog dismissal preserve the review and unsaved-input protection', async ({ page }, info) => {
  const api = await start(page), text = jsonOf();
  await open(page, text); await stage(page); await finalConfirmation(page);
  await alert(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(alert(page)).toHaveCount(0); await expect(review(page)).toBeVisible();
  await expect(confirmButton(page)).toBeFocused();
  await expect(jsonInput(page)).toHaveValue(text);
  await finalConfirmation(page); await page.keyboard.press('Escape');
  await expect(alert(page)).toHaveCount(0); await expect(review(page)).toBeVisible();
  await expect(confirmButton(page)).toBeFocused();
  const waiting = page.waitForEvent('dialog');
  await page.evaluate(() => { window.setTimeout(() => window.location.reload(), 0); });
  const native = await waiting; expect(native.type()).toBe('beforeunload'); await native.dismiss();
  await expect(review(page)).toBeVisible(); await expect(jsonInput(page)).toHaveValue(text);
  for (const method of ['Escape', 'Close', 'Backdrop']) {
    await jsonInput(page).focus();
    if (method === 'Escape') await page.keyboard.press('Escape');
    else if (method === 'Close') await form(page).getByRole('button', { name: 'Close', exact: true }).click();
    else if (info.project.use.hasTouch) await page.touchscreen.tap(10, 10);
    else await page.mouse.click(10, 10);
    await expect(alert(page).getByRole('heading', { name: '保存していない入力を破棄しますか？', exact: true })).toBeVisible();
    await alert(page).getByRole('button', { name: '編集を続ける', exact: true }).click();
    if (method !== 'Close') await expect(jsonInput(page)).toBeFocused();
    await expect(review(page)).toBeVisible(); await expect(jsonInput(page)).toHaveValue(text);
  }
  expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('invalid or hostile JSON is rejected before a review or write can occur', async ({ page }) => {
  const api = await start(page); await open(page, null);
  await expect(reviewButton(page)).toBeDisabled();
  const dangerousUrl = incoming(); dangerousUrl.accounts[0].url = 'javascript:window.__importExecuted=true';
  const missingPerson = incoming(); missingPerson.accounts[0].personId = 'does-not-exist';
  const repeatedId = incoming(); repeatedId.people[2].id = repeatedId.people[0].id;
  const repeatedAccount = incoming(); repeatedAccount.accounts[2].id = repeatedAccount.accounts[0].id;
  for (const text of [
    '{broken', '[]', jsonOf(incoming(), 'unknown-format'), JSON.stringify({ format: 'daredakke', version: 2, data: incoming() }),
    jsonOf(dangerousUrl), jsonOf(missingPerson), jsonOf(repeatedId), jsonOf(repeatedAccount),
  ]) {
    await jsonInput(page).fill(text); await reviewButton(page).click();
    await expect(form(page).getByRole('alert')).toBeVisible();
    await expect(review(page)).toHaveCount(0); await expect(alert(page)).toHaveCount(0);
    await expect(jsonInput(page)).toHaveValue(text);
    expect(api.posts).toHaveLength(0);
  }
  expect(await page.evaluate(() => window.__importExecuted)).toBeUndefined();
  expect(api.scopes.demo.state.data).toEqual(current()); expect(api.errors).toEqual([]);
});

test('UTF-8 size limits and invalid files never create an accidental empty replacement', async ({ page }) => {
  const api = await start(page); await open(page, null);
  const oversized = incoming(); oversized.people[0].notes = 'あ'.repeat(310000);
  await jsonInput(page).fill(jsonOf(oversized)); await reviewButton(page).click();
  await expect(form(page).getByRole('alert')).toContainText('900KB');
  await expect(review(page)).toHaveCount(0);
  await jsonInput(page).fill('');
  await chooseFile(page, 'oversized-synthetic.json', ' '.repeat(900001));
  await expect(page.getByText('JSONファイルは900KBまでです。', { exact: true })).toBeVisible();
  await expect(jsonInput(page)).toHaveValue('');
  await chooseFile(page, 'invalid-synthetic.json', '{broken');
  await expect(page.getByText('読み込めるJSONではありません。', { exact: true })).toBeVisible();
  await expect(jsonInput(page)).toHaveValue(''); await expect(reviewButton(page)).toBeDisabled();
  expect(api.posts).toHaveLength(0); expect(api.scopes.demo.state.data).toEqual(current()); expect(api.errors).toEqual([]);
});

test('empty replacement requires a fresh native checkbox acknowledgment before final confirmation', async ({ page }, info) => {
  const api = await start(page); await open(page, jsonOf(empty())); await stage(page);
  await counts(page, '人の変更', { '現在': 3, '読み込み後': 0, '追加': 0, '更新': 0, '取り除く': 3, '変更なし': 0 });
  await expect(acknowledgment(page)).toHaveAttribute('type', 'checkbox');
  await expect(acknowledgment(page)).not.toBeChecked(); await expect(confirmButton(page)).toBeDisabled();
  await noOverflow(page); await acknowledgment(page).scrollIntoViewIfNeeded();
  await info.attach('empty-import-warning-' + page.viewportSize().width, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  await acknowledgment(page).focus(); await page.keyboard.press('Space');
  await expect(acknowledgment(page)).toBeChecked(); await expect(confirmButton(page)).toBeEnabled();
  await acknowledgment(page).uncheck(); await expect(confirmButton(page)).toBeDisabled();
  await acknowledgment(page).check(); await finalConfirmation(page);
  await alert(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
  expect(api.posts).toHaveLength(0);
  await jsonInput(page).fill(jsonOf()); await expect(review(page)).toHaveCount(0);
  await jsonInput(page).fill(jsonOf(empty())); await stage(page);
  await expect(acknowledgment(page)).not.toBeChecked(); await expect(confirmButton(page)).toBeDisabled();
  await acknowledgment(page).check(); await finalConfirmation(page); await finalButton(page).click();
  await expect(form(page)).toHaveCount(0);
  expect(api.posts).toHaveLength(1); expect(api.scopes.demo.state.data).toEqual(empty());
  expect(api.scopes.demo.state.undo[0].data).toEqual(current()); expect(api.errors).toEqual([]);
});

test('one approved import targets only the selected namespace/scope, ignores hostile metadata and remains undoable', async ({ page }) => {
  const api = await start(page);
  await page.getByRole('button', { name: 'マイレコード', exact: true }).click();
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  const data = incoming();
  data.people[0].notes = '<img src=x onerror="window.__importExecuted=true">';
  data.accounts[2].key = 'X:untrusted-key';
  data.accounts[2].url = 'https://twitter.com/FIXTURE_KEEP?tracking=synthetic';
  await open(page, jsonOf(data, 'daredakke', { owner: 'attacker', namespace: namespaceB, scope: 'demo' })); await stage(page);
  await expect(review(page)).toContainText('マイレコード');
  await expect(review(page)).toContainText(/重複候補.*1/);
  expect(api.posts).toHaveLength(0);
  await finalConfirmation(page); await finalButton(page).click(); await expect(form(page)).toHaveCount(0);
  expect(api.posts).toHaveLength(1);
  expect(api.posts[0].scope).toBe('personal'); expect(api.posts[0].expectedNamespace).toBe(namespaceA);
  expect(api.scopes.demo.state).toEqual({ data: current(), undo: [] });
  expect(api.scopes.personal.state.data.accounts[2].key).toBe('X:fixture_keep');
  expect(api.scopes.personal.state.data.accounts[2].url).toBe('https://x.com/fixture_keep');
  expect(api.scopes.personal.state.undo).toHaveLength(1); expect(api.scopes.personal.state.undo[0].data).toEqual(current());
  await expect(page.locator('img, iframe')).toHaveCount(0);
  expect(await page.evaluate(() => window.__importExecuted)).toBeUndefined();
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect.poll(() => api.posts.length).toBe(2);
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  expect(api.scopes.personal.state.data).toEqual(current()); expect(api.scopes.personal.state.undo).toEqual([]);
  expect(api.errors).toEqual([]);
});

test('ordinary save failure retains text/review and a deliberate retry adds exactly one history entry', async ({ page }) => {
  const api = await start(page), text = jsonOf();
  api.responses.push({ status: 500, json: { error: 'Synthetic save failure' } });
  await open(page, text); await stage(page); await finalConfirmation(page); await finalButton(page).click();
  await expect(form(page).getByRole('alert')).toHaveText('Synthetic save failure');
  await expect(review(page)).toBeVisible(); await expect(jsonInput(page)).toHaveValue(text);
  expect(api.posts).toHaveLength(1); expect(api.scopes.demo.state).toEqual({ data: current(), undo: [] });
  await finalConfirmation(page); await finalButton(page).click(); await expect(form(page)).toHaveCount(0);
  expect(api.posts).toHaveLength(2); expect(api.scopes.demo.state.data).toEqual(incoming());
  expect(api.scopes.demo.state.undo).toHaveLength(1); expect(api.scopes.demo.state.undo[0].data).toEqual(current());
  expect(api.errors).toEqual([]);
});

test('an in-flight save locks the import controls and cannot enqueue a second write', async ({ page }) => {
  const api = await start(page); await open(page); await stage(page); await finalConfirmation(page);
  api.postGate = gate(); await finalButton(page).click();
  await expect.poll(() => api.posts.length).toBe(1);
  await expect(jsonInput(page)).toBeDisabled(); await expect(confirmButton(page)).toBeDisabled();
  await expect(form(page).getByRole('button', { name: 'ファイルを選ぶ', exact: true })).toBeDisabled();
  await page.keyboard.press('Enter'); expect(api.posts).toHaveLength(1);
  api.postGate.resolve(); await expect(form(page)).toHaveCount(0);
  expect(api.posts).toHaveLength(1); expect(api.scopes.demo.state.undo).toHaveLength(1); expect(api.errors).toEqual([]);
});

test('file provenance is literal, a pasted edit resets it, and the newest file wins an async read race', async ({ page }) => {
  const api = await start(page); await open(page, null);
  const older = jsonOf(current()), newest = jsonOf(incoming(), 'friend-record');
  await chooseFile(page, 'deferred-older.json', older); await waitForFile(page, 'deferred-older.json');
  await expect(reviewButton(page)).toBeDisabled();
  const filename = 'deferred-newest-<img-onerror=fixture>-' + 'L'.repeat(100) + '.json';
  await chooseFile(page, filename, newest); await waitForFile(page, filename);
  await resolveFile(page, filename, newest); await expect(jsonInput(page)).toHaveValue(newest); await stage(page);
  await expect(review(page)).toContainText(filename); await expect(review(page)).toContainText('friend-record');
  await expect(form(page).locator('img, iframe')).toHaveCount(0); await noOverflow(page);
  await resolveFile(page, 'deferred-older.json', older);
  await expect(jsonInput(page)).toHaveValue(newest); await expect(review(page)).toContainText(filename);
  await chooseFile(page, 'deferred-after-preview.json', older); await waitForFile(page, 'deferred-after-preview.json');
  await expect(review(page)).toHaveCount(0); await expect(reviewButton(page)).toBeDisabled();
  const edited = newest + '\n'; await jsonInput(page).fill(edited);
  await expect(review(page)).toHaveCount(0); await stage(page);
  await expect(review(page)).toContainText('貼り付けたJSON'); await expect(review(page)).not.toContainText(filename);
  await resolveFile(page, 'deferred-after-preview.json', older);
  await expect(jsonInput(page)).toHaveValue(edited); await expect(review(page)).toContainText('貼り付けたJSON');
  expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('a pending File.text cannot overwrite pasted JSON, block same-file retry or reopen a discarded import', async ({ page }) => {
  const api = await start(page); await open(page, null);
  const filename = 'deferred-before-edit.json';
  await chooseFile(page, filename); await waitForFile(page, filename);
  const pasted = jsonOf(current()); await jsonInput(page).fill(pasted); await stage(page);
  await expect(page.getByLabel('JSONファイルを選択', { exact: true })).toHaveValue('');
  // Select the same filename again while the original read is still pending.
  // The first completion must not replace typed text or release the new gate.
  await chooseFile(page, filename);
  await expect.poll(() => page.evaluate(name => window.__syntheticFileHistory.filter(read => read.name === name).length, filename)).toBe(2);
  await expect(review(page)).toHaveCount(0); await expect(reviewButton(page)).toBeDisabled();
  await page.evaluate(({ name, text }) => window.__syntheticFileHistory.find(read => read.name === name).resolve(text), { name: filename, text: jsonOf() });
  await expect(jsonInput(page)).toHaveValue(pasted); await expect(reviewButton(page)).toBeDisabled();
  await resolveFile(page, filename, jsonOf()); await expect(jsonInput(page)).toHaveValue(jsonOf()); await stage(page);
  await expect(review(page)).toContainText(filename);
  await jsonInput(page).fill('');
  await chooseFile(page, 'deferred-after-close.json'); await waitForFile(page, 'deferred-after-close.json');
  await form(page).getByRole('button', { name: 'Close', exact: true }).click(); await expect(form(page)).toHaveCount(0);
  await resolveFile(page, 'deferred-after-close.json', jsonOf()); await expect(form(page)).toHaveCount(0);
  await open(page, null); await expect(jsonInput(page)).toHaveValue(''); await expect(review(page)).toHaveCount(0);
  expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('namespace mismatch at initial load leaves import unavailable', async ({ page }) => {
  const api = await start(page, { namespace: namespaceB, recordsNamespace: namespaceA, loadError: true });
  await expect(page.getByRole('button', { name: 'JSONを読み込む', exact: true })).toBeDisabled();
  await expect(form(page)).toHaveCount(0); expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('a session check pauses review actions and a changed owner clears the final confirmation and text', async ({ page }) => {
  const api = await start(page); await open(page); await stage(page);
  api.sessionGate = gate(); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('status')).toHaveText('ログインを確認しています…');
  await expect(finalButton(page)).toHaveCount(0); expect(api.posts).toHaveLength(0);
  api.sessionGate.resolve(); api.sessionGate = null;
  await expect(review(page)).toBeVisible(); await finalConfirmation(page);
  api.sessionGate = gate(); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('status')).toHaveText('ログインを確認しています…');
  await expect(finalButton(page)).toHaveCount(0);
  api.sessionGate.resolve(); api.sessionGate = null;
  await expect(finalButton(page)).toBeEnabled();
  await alert(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(alert(page)).toHaveCount(0); await expect(confirmButton(page)).toBeFocused();
  // Also cover a fast same-owner response, which can precede Radix's deferred cleanup.
  await finalConfirmation(page); const completed = api.sessionCompleted;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => api.sessionCompleted).toBeGreaterThan(completed);
  await expect(finalButton(page)).toBeEnabled();
  await alert(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(alert(page)).toHaveCount(0); await expect(confirmButton(page)).toBeFocused();
  await finalConfirmation(page);
  api.namespace = namespaceB; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert').filter({ hasText: 'ログイン' })).toBeVisible();
  await expect(form(page)).toHaveCount(0); await expect(alert(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'JSONを読み込む', exact: true })).toBeDisabled();
  api.namespace = namespaceA;
  await page.getByRole('button', { name: '再読み込み', exact: true }).click(); await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await open(page, null); await expect(jsonInput(page)).toHaveValue(''); await expect(review(page)).toHaveCount(0);
  expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('a late file read and an identity-changed save response cannot retain another session draft', async ({ page }) => {
  const api = await start(page); await open(page, null);
  await chooseFile(page, 'deferred-other-owner.json'); await waitForFile(page, 'deferred-other-owner.json');
  api.namespace = namespaceB; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert').filter({ hasText: 'ログイン' })).toBeVisible(); await expect(form(page)).toHaveCount(0);
  await resolveFile(page, 'deferred-other-owner.json', jsonOf()); await expect(form(page)).toHaveCount(0);
  api.namespace = namespaceA;
  await page.getByRole('button', { name: '再読み込み', exact: true }).click(); await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await open(page); await stage(page);
  api.responses.push({ status: 409, json: { code: 'identity_changed', error: 'Synthetic login changed' } });
  await finalConfirmation(page); await finalButton(page).click();
  await expect(form(page)).toHaveCount(0); await expect(alert(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'JSONを読み込む', exact: true })).toBeDisabled();
  expect(api.posts).toHaveLength(1); expect(api.scopes.demo.state).toEqual({ data: current(), undo: [] }); expect(api.errors).toEqual([]);
});

test('review and final confirmation fit 390/1280px, preserve keyboard focus and supply synthetic screenshots', async ({ page }, info) => {
  const api = await start(page); await open(page, null);
  const filename = 'synthetic-' + 'VeryLongUnbrokenFilename'.repeat(7) + '.json';
  await chooseFile(page, filename); await expect(jsonInput(page)).toHaveValue(jsonOf()); await stage(page); await noOverflow(page);
  await review(page).getByRole('heading', { name: '読み込み内容の確認', exact: true }).scrollIntoViewIfNeeded();
  await info.attach('import-review-' + page.viewportSize().width, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  await confirmButton(page).focus(); await page.keyboard.press('Enter'); await expect(alert(page)).toBeVisible();
  const cancel = alert(page).getByRole('button', { name: 'キャンセル', exact: true }); await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('[role="alertdialog"]') !== null)).toBe(true);
  await page.keyboard.press('Tab'); await expect(cancel).toBeFocused();
  const bounds = await alert(page).boundingBox(), viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1); expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
  if (info.project.use.isMobile) {
    for (const button of [cancel, finalButton(page)]) {
      const box = await button.boundingBox(); expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
  await info.attach('import-confirmation-' + viewport.width, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  await page.keyboard.press('Escape'); await expect(alert(page)).toHaveCount(0); await expect(confirmButton(page)).toBeFocused();
  expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});
