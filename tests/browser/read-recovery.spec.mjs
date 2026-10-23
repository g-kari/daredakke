import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const origin = 'http://127.0.0.1:4317';
const namespaceA = 'u_' + 'a'.repeat(64), namespaceB = 'u_' + 'b'.repeat(64);
const deadline = 15000;
const fixtures = new WeakMap();
const saved = () => ({ people: [{ id: 'recovery-saved', name: 'Saved synthetic friend', aliases: [], tags: [], notes: 'Saved synthetic note', color: '#4f5fcb' }], accounts: [] });
const importJSON = JSON.stringify({ format: 'daredakke', version: 1, data: { people: [], accounts: [] } });
const loading = page => page.getByRole('status').filter({ hasText: 'ログインを確認しています…' });
const recovery = page => page.getByRole('heading', { name: 'ログインを確認できませんでした', exact: true });
const retry = page => page.getByRole('button', { name: 'ログインを再確認する', exact: true });

async function start(page, plans = [], loaded = true) {
  const api = { violations: [], errors: [], downloads: [] };
  fixtures.set(page, api);
  page.on('pageerror', error => api.errors.push(error.message));
  page.on('download', download => api.downloads.push(download.suggestedFilename()));
  // This is the real production build in Chromium. Only the synthetic API and
  // existing WebMCP registration fixture are intercepted. Deliberately ignoring
  // AbortSignal in controlled promises proves that late fetch/body completion
  // cannot bypass the application's deadline or operation-generation fence.
  await page.addInitScript(({ origin, namespace, data, plans }) => {
    const nativeFetch = window.fetch.bind(window);
    const gates = new Map();
    const api = window.__readRecovery = {
      namespace, data, plans, calls: [], violations: [], clipboard: [], blobs: [], storageWrites: [],
      resolve(id) { const gate = gates.get(id); if (!gate) throw new Error('Unknown synthetic gate: ' + id); gate(); },
    };
    window.__daredakkeTools = new Map();
    Object.defineProperty(document, 'modelContext', { configurable: true, value: {
      registerTool(tool) { window.__daredakkeTools.set(tool.name, tool); },
    } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      async writeText(text) { api.clipboard.push(text); },
    } });
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { api.blobs.push(blob.size); return createObjectURL(blob); };
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { api.storageWrites.push({ key, value }); return setItem.call(this, key, value); };
    window.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (!url.pathname.startsWith('/api/')) return nativeFetch(input, options);
      const method = options.method || (input instanceof Request ? input.method : 'GET');
      if (url.origin !== origin || method !== 'GET' ||
          !((url.pathname === '/api/session' && !url.search) ||
            (url.pathname === '/api/records' && ['demo', 'personal'].includes(url.searchParams.get('scope')) && url.searchParams.size === 1))) {
        api.violations.push(`${method} ${url.origin}${url.pathname}${url.search}`);
        throw new Error('Unexpected synthetic API operation');
      }
      const index = api.plans.findIndex(plan => plan.path === url.pathname);
      const plan = index < 0 ? {} : api.plans.splice(index, 1)[0];
      const call = { id: plan.id || 'normal-' + api.calls.length, path: url.pathname, at: performance.now(), phase: 'fetch', aborted: Boolean(options.signal?.aborted), completed: false };
      api.calls.push(call);
      options.signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
      const value = plan.value ?? (url.pathname === '/api/session' ? { namespace: api.namespace } : { namespace: api.namespace, revision: 0, state: { data: api.data, undo: [] } });
      // Snapshot before waiting so stale replies really carry their old owner.
      const body = plan.malformed ? '{' : JSON.stringify(value);
      const wait = plan.phase ? new Promise(resolve => gates.set(call.id, resolve)) : null;
      if (plan.phase === 'fetch') await wait;
      call.phase = 'response';
      const response = new Response(body, { status: plan.status || 200, headers: { 'Content-Type': 'application/json' } });
      const json = response.json.bind(response);
      response.json = async () => {
        call.phase = 'body';
        if (plan.phase === 'body') await wait;
        try { return await json(); }
        finally { call.completed = true; call.phase = 'complete'; }
      };
      return response;
    };
  }, { origin, namespace: namespaceA, data: saved(), plans });
  await page.context().route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || request.method() !== 'GET' || url.pathname.startsWith('/api/')) {
      api.violations.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  await page.clock.install({ time: new Date('2026-10-15T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-15T00:00:01Z'));
  await page.goto('/');
  if (loaded) await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__daredakkeTools.has('search_friend_records'))).toBe(true);
  return api;
}

test.afterEach(async ({ page }) => {
  const api = fixtures.get(page);
  if (!api) return;
  const synthetic = await page.evaluate(() => ({
    violations: window.__readRecovery.violations,
    clipboard: window.__readRecovery.clipboard,
    blobs: window.__readRecovery.blobs,
    storageWrites: window.__readRecovery.storageWrites,
  }));
  expect(api.errors, 'The actual built UI must not throw').toEqual([]);
  expect(api.violations, 'Only exact-loopback static GETs may reach the network').toEqual([]);
  expect(synthetic.violations, 'No unexpected API or POST may be attempted').toEqual([]);
  expect(api.downloads, 'Blocked recovery must not create a download').toEqual([]);
  expect(synthetic.clipboard, 'Blocked recovery must not copy private records').toEqual([]);
  expect(synthetic.blobs, 'Blocked recovery must not generate an export').toEqual([]);
  expect(synthetic.storageWrites, 'Draft recovery stays memory-only').toEqual([]);
});

async function plan(page, specification) {
  await page.evaluate(specification => window.__readRecovery.plans.push(specification), specification);
}
async function calls(page, path = '/api/session') {
  return page.evaluate(path => window.__readRecovery.calls.filter(call => call.path === path), path);
}
async function waitForGate(page, id, phase) {
  await expect.poll(() => page.evaluate(({ id, phase }) => window.__readRecovery.calls.some(call => call.id === id && call.phase === phase), { id, phase })).toBe(true);
}
async function resolve(page, id) {
  await page.evaluate(id => window.__readRecovery.resolve(id), id);
  // A canceled operation may correctly decline to parse its late fetch reply.
  // Require the controlled promise to settle, without requiring abandoned JSON
  // to be consumed by the application.
  await expect.poll(() => page.evaluate(id => ['response', 'complete'].includes(window.__readRecovery.calls.find(call => call.id === id)?.phase), id)).toBe(true);
}
async function tool(page, name = 'search_friend_records', input = { query: '' }) {
  return page.evaluate(async ({ name, input }) => {
    try { return { result: await window.__daredakkeTools.get(name).execute(input) }; }
    catch (error) { return { error: error.message }; }
  }, { name, input });
}
async function event(page, type = 'focus') {
  await page.evaluate(type => (type === 'focus' ? window : document).dispatchEvent(new Event(type)), type);
}
async function checkBlocked(page) {
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByText('Saved synthetic note', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'JSONを書き出す', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存する', exact: true })).toHaveCount(0);
  expect((await tool(page)).error).toBe('ログイン確認中です。');
  expect((await tool(page, 'start_person_creation', {})).error).toBe('ログイン確認中です。');
}
async function expire(page, id) {
  const remaining = await page.evaluate(({ id, deadline }) => {
    const call = window.__readRecovery.calls.find(call => call.id === id);
    return call.at + deadline - performance.now();
  }, { id, deadline });
  expect(remaining).toBeGreaterThanOrEqual(1);
  await page.clock.runFor(remaining - 1);
  await expect(recovery(page)).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(recovery(page)).toBeVisible();
  await checkBlocked(page);
  expect((await page.evaluate(id => window.__readRecovery.calls.find(call => call.id === id), id)).aborted).toBe(true);
}
async function noAutomaticRetry(page) {
  const before = await page.evaluate(() => window.__readRecovery.calls);
  await event(page, 'focus');
  await event(page, 'visibilitychange');
  await page.clock.runFor(60000);
  expect(await page.evaluate(() => window.__readRecovery.calls)).toEqual(before);
  await expect(recovery(page)).toBeVisible();
}
async function draft(page, kind) {
  let dialog, field, value;
  if (kind === 'person') {
    await page.locator('.collection-actions').getByRole('button', { name: '人を追加', exact: true }).click({ force: true });
    dialog = page.getByRole('dialog', { name: '人を追加', exact: true });
    await dialog.getByLabel('名前 必須', { exact: true }).fill('Unsaved synthetic friend');
    await dialog.getByLabel('別名', { exact: true }).fill('Synthetic alias');
    await dialog.getByLabel('タグ', { exact: true }).fill('Synthetic tag');
    field = dialog.getByRole('textbox', { name: 'メモ', exact: true });
    value = 'Unsaved synthetic recovery note';
  } else if (kind === 'account') {
    await page.locator('.collection-actions').getByRole('button', { name: 'アカウントを追加', exact: true }).click({ force: true });
    dialog = page.getByRole('dialog', { name: 'アカウントを追加', exact: true });
    await dialog.getByLabel('表示名', { exact: true }).fill('Unsaved synthetic account');
    field = dialog.getByLabel('プロフィールURL / ID 必須', { exact: true });
    value = '100000000000000099';
  } else {
    await page.getByRole('button', { name: 'JSONを読み込む', exact: true }).click({ force: true });
    dialog = page.getByRole('dialog', { name: 'JSONを読み込む', exact: true });
    field = dialog.getByRole('textbox', { name: 'JSON', exact: true });
    value = importJSON;
  }
  await field.fill(value);
  return { dialog, field, value };
}
async function expectDraft(page, kind, expected) {
  await expect(expected.dialog).toBeVisible();
  await expect(expected.field).toHaveValue(expected.value);
  if (kind === 'person') {
    await expect(expected.dialog.getByLabel('名前 必須', { exact: true })).toHaveValue('Unsaved synthetic friend');
    await expect(expected.dialog.getByLabel('別名', { exact: true })).toHaveValue('Synthetic alias');
    await expect(expected.dialog.getByLabel('タグ', { exact: true })).toHaveValue('Synthetic tag');
  } else if (kind === 'account') await expect(expected.dialog.getByLabel('表示名', { exact: true })).toHaveValue('Unsaved synthetic account');
}
async function screenshot(page, info, label) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await mkdir('test-results/read-recovery', { recursive: true });
  const path = `test-results/read-recovery/${info.project.name}-${label}.png`;
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach('read-recovery-' + label, { path, contentType: 'image/png' });
}

for (const path of ['/api/records', '/api/session']) for (const phase of ['fetch', 'body']) {
  test(`initial ${path} ${phase} deadline requires explicit reload and ignores a late reply`, async ({ page }) => {
    const stale = saved(); stale.people[0].name = 'Stale synthetic initial response';
    const value = path === '/api/records' ? { namespace: namespaceA, revision: 99, state: { data: stale, undo: [] } } : { namespace: namespaceB };
    await start(page, [{ path, phase, id: 'initial-stuck', value }], false);
    await waitForGate(page, 'initial-stuck', phase);
    await expire(page, 'initial-stuck');
    await expect(page.getByRole('button', { name: 'もう一度読み込む', exact: true })).toBeVisible();
    await expect(retry(page)).toHaveCount(0);
    await noAutomaticRetry(page);
    const before = (await calls(page, '/api/records')).length;
    await page.getByRole('button', { name: 'もう一度読み込む', exact: true }).click({ force: true });
    await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
    expect((await calls(page, '/api/records')).length).toBe(before + 1);
    await resolve(page, 'initial-stuck');
    await expect(recovery(page)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect((await tool(page)).result.people.map(person => person.name)).toEqual(['Saved synthetic friend']);
  });
}

for (const kind of ['person', 'account', 'import']) for (const phase of ['fetch', 'body']) {
  test(`${kind} draft survives a ${phase} deadline only after explicit same-owner verification`, async ({ page }, info) => {
    await start(page);
    const expected = await draft(page, kind);
    await plan(page, { path: '/api/session', phase, id: 'draft-stuck' });
    // Also exercise save/import handlers in the same event turn, before React
    // removes the old UI. sessionPending must synchronously guard these paths.
    await page.evaluate(() => {
      const form = document.querySelector('[role="dialog"] form');
      const stage = [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === '内容を確認して読み込む');
      window.dispatchEvent(new Event('focus'));
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      stage?.click();
    });
    await waitForGate(page, 'draft-stuck', phase);
    await expect(loading(page)).toBeVisible();
    await checkBlocked(page);
    await expire(page, 'draft-stuck');
    await expect(retry(page)).toBeVisible();
    if (kind === 'person' && phase === 'fetch') await screenshot(page, info, 'timeout-recovery');
    await noAutomaticRetry(page);
    await resolve(page, 'draft-stuck');
    await expect(recovery(page)).toBeVisible();
    await checkBlocked(page);
    await plan(page, { path: '/api/session', phase: 'fetch', id: 'explicit-retry' });
    await retry(page).click({ force: true });
    await waitForGate(page, 'explicit-retry', 'fetch');
    await expect(loading(page)).toBeVisible();
    await checkBlocked(page);
    await resolve(page, 'explicit-retry');
    await expectDraft(page, kind, expected);
    if (kind === 'person' && phase === 'fetch') await screenshot(page, info, 'same-owner-preserved-input');
    expect((await tool(page)).result.people.map(person => person.name)).toEqual(['Saved synthetic friend']);
  });
}

test('pending and timed-out verification blocks already-open export download and clipboard handlers', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'JSONを書き出す', exact: true }).click({ force: true });
  await expect(page.getByRole('textbox', { name: '書き出しJSON', exact: true })).toBeVisible();
  await plan(page, { path: '/api/session', phase: 'body', id: 'export-stuck' });
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('[role="dialog"] button')];
    const download = buttons.find(button => button.textContent === 'ファイルを保存');
    const copy = buttons.find(button => button.textContent === 'コピー');
    window.dispatchEvent(new Event('focus'));
    download?.click(); copy?.click();
  });
  await waitForGate(page, 'export-stuck', 'body');
  await checkBlocked(page);
  await expire(page, 'export-stuck');
  await noAutomaticRetry(page);
});

test('a timed-out session interrupts final JSON replacement confirmation and retains review for explicit reconfirmation', async ({ page }) => {
  await start(page);
  const expected = await draft(page, 'import');
  const review = expected.dialog.getByRole('region', { name: '読み込み内容の確認', exact: true });
  const confirm = () => expected.dialog.getByRole('button', { name: '置き換えを確認する', exact: true });
  const alert = page.getByRole('alertdialog');
  await expected.dialog.getByRole('button', { name: '内容を確認して読み込む', exact: true }).click({ force: true });
  await expect(review).toBeVisible();
  await expected.dialog.getByRole('checkbox', { name: 'この保存先の記録を空にすることを確認しました', exact: true }).check({ force: true });
  await confirm().click({ force: true });
  await expect(alert.getByRole('button', { name: '置き換えて読み込む', exact: true })).toBeVisible();
  await plan(page, { path: '/api/session', phase: 'body', id: 'replacement-stuck' });
  await event(page);
  await waitForGate(page, 'replacement-stuck', 'body');
  await checkBlocked(page);
  await expire(page, 'replacement-stuck');
  await noAutomaticRetry(page);
  await resolve(page, 'replacement-stuck');
  await expect(recovery(page)).toBeVisible();
  await retry(page).click({ force: true });
  await expectDraft(page, 'import', expected);
  await expect(review).toBeVisible();
  await expect(review).toContainText('現在');
  await expect(review.getByRole('status')).toHaveText('ログイン確認で置き換えの確認を中断しました。内容を確かめてから、もう一度進んでください。');
  await expect(alert).toHaveCount(0);
  await expect(confirm()).toBeEnabled();
  expect(await page.evaluate(() => window.__readRecovery.violations.filter(operation => operation.startsWith('POST ')))).toEqual([]);
  await page.clock.runFor(60000);
  await expect(alert).toHaveCount(0);
  await expect(expected.field).toHaveValue(expected.value);
  // Merely verifying the owner cannot revive the old final confirmation. The
  // user must explicitly review and open a fresh confirmation before any POST.
  // Deadline assertions are complete. Let modal animation/actionability advance
  // before exercising these explicit user actions; do not force a covered target.
  await page.clock.resume();
  await confirm().click();
  await expect(alert.getByRole('button', { name: '置き換えて読み込む', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__readRecovery.violations.filter(operation => operation.startsWith('POST ')))).toEqual([]);
  await alert.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(review).toBeVisible();
  await expect(expected.field).toHaveValue(expected.value);
});

test('a timed-out session closes a dirty person discard alert without discarding or reviving it after retry', async ({ page }) => {
  await start(page);
  const expected = await draft(page, 'person');
  const alert = page.getByRole('alertdialog');
  await expected.dialog.getByRole('button', { name: 'キャンセル', exact: true }).click({ force: true });
  await expect(alert.getByRole('button', { name: '入力を破棄する', exact: true })).toBeVisible();
  await plan(page, { path: '/api/session', phase: 'body', id: 'discard-stuck' });
  await event(page);
  await waitForGate(page, 'discard-stuck', 'body');
  await checkBlocked(page);
  await expire(page, 'discard-stuck');
  await resolve(page, 'discard-stuck');
  await expect(recovery(page)).toBeVisible();
  await retry(page).click({ force: true });
  await expectDraft(page, 'person', expected);
  await expect(alert).toHaveCount(0);
  await page.clock.runFor(60000);
  await expectDraft(page, 'person', expected);
  await expect(alert).toHaveCount(0);
  await expected.dialog.getByRole('button', { name: 'キャンセル', exact: true }).click({ force: true });
  await expect(alert.getByRole('button', { name: '入力を破棄する', exact: true })).toBeVisible();
  await alert.getByRole('button', { name: '編集を続ける', exact: true }).click({ force: true });
  await expectDraft(page, 'person', expected);
  await expect(alert).toHaveCount(0);
});

for (const rejection of [
  { title: 'owner mismatch', kind: 'person', value: { namespace: namespaceB } },
  { title: '401 with stalled error body', kind: 'account', status: 401, phase: 'body' },
  { title: '403 with stalled error body', kind: 'import', status: 403, phase: 'body' },
  { title: '503 with stalled error body', kind: 'person', status: 503, phase: 'body' },
  { title: 'invalid namespace', kind: 'account', value: { namespace: 'invalid-synthetic-owner' } },
  { title: 'malformed JSON', kind: 'import', malformed: true },
]) {
  test(`explicit recovery ${rejection.title} clears the old draft and saved records`, async ({ page }) => {
    await start(page);
    await draft(page, rejection.kind);
    await plan(page, { path: '/api/session', phase: 'fetch', id: 'rejected-timeout' });
    await event(page);
    await waitForGate(page, 'rejected-timeout', 'fetch');
    await expire(page, 'rejected-timeout');
    await plan(page, { path: '/api/session', id: 'actual-rejection', ...rejection });
    await retry(page).click({ force: true });
    await expect(page.getByRole('alert').filter({ hasText: 'ログイン' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.person-row')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '人を追加', exact: true })).toBeDisabled();
    await expect(retry(page)).toHaveCount(0);
    expect((await tool(page)).error).toBe('ログイン確認中です。');
    expect((await tool(page, 'start_person_creation', {})).error).toBe('ログイン確認中です。');
    if (rejection.status) {
      // Non-OK headers establish failure immediately. A stalled error body
      // must never be mistaken for an inconclusive timeout preserving drafts.
      expect((await page.evaluate(() => window.__readRecovery.calls.find(call => call.id === 'actual-rejection'))).phase).toBe('response');
    }
    await resolve(page, 'rejected-timeout');
    expect((await tool(page)).error).toBe('ログイン確認中です。');
    await page.clock.runFor(deadline);
    await expect(recovery(page)).toHaveCount(0);
    await page.getByRole('button', { name: /^(再読み込み|もう一度読み込む)$/ }).click({ force: true });
    await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
    if (rejection.kind === 'person') {
      await page.locator('.collection-actions').getByRole('button', { name: '人を追加', exact: true }).click({ force: true });
      await expect(page.getByRole('dialog').getByLabel('名前 必須', { exact: true })).toHaveValue('');
      await expect(page.getByRole('dialog').getByRole('textbox', { name: 'メモ', exact: true })).toHaveValue('');
    } else if (rejection.kind === 'account') {
      await page.locator('.collection-actions').getByRole('button', { name: 'アカウントを追加', exact: true }).click({ force: true });
      await expect(page.getByRole('dialog').getByLabel('表示名', { exact: true })).toHaveValue('');
      await expect(page.getByRole('dialog').getByLabel('プロフィールURL / ID 必須', { exact: true })).toHaveValue('');
    } else {
      await page.getByRole('button', { name: 'JSONを読み込む', exact: true }).click({ force: true });
      await expect(page.getByRole('dialog').getByRole('textbox', { name: 'JSON', exact: true })).toHaveValue('');
    }
  });
}

test('a newer visibility probe gets its full deadline and stale mismatched replies cannot settle it', async ({ page }) => {
  await start(page);
  const expected = await draft(page, 'account');
  await plan(page, { path: '/api/session', phase: 'body', id: 'older', value: { namespace: namespaceB } });
  await event(page);
  await waitForGate(page, 'older', 'body');
  await page.clock.runFor(7000);
  await plan(page, { path: '/api/session', phase: 'fetch', id: 'newer' });
  await event(page, 'visibilitychange');
  await waitForGate(page, 'newer', 'fetch');
  await page.clock.runFor(8001);
  await expect(loading(page)).toBeVisible();
  await expect(recovery(page)).toHaveCount(0);
  await resolve(page, 'older');
  await expect(loading(page)).toBeVisible();
  await expire(page, 'newer');
  await resolve(page, 'newer');
  await expect(recovery(page)).toBeVisible();
  await retry(page).click({ force: true });
  await expectDraft(page, 'account', expected);
});

test('a newer same-owner success cancels the older deadline and late mismatch without losing JSON', async ({ page }) => {
  await start(page);
  const expected = await draft(page, 'import');
  await plan(page, { path: '/api/session', phase: 'fetch', id: 'superseded', value: { namespace: namespaceB } });
  await event(page);
  await waitForGate(page, 'superseded', 'fetch');
  await page.clock.runFor(5000);
  await event(page);
  await expectDraft(page, 'import', expected);
  await page.clock.runFor(60000);
  await expectDraft(page, 'import', expected);
  await resolve(page, 'superseded');
  await expectDraft(page, 'import', expected);
  await expect(recovery(page)).toHaveCount(0);
});
