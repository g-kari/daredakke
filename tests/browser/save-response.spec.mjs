import { test, expect } from '@playwright/test';

const origin = 'http://127.0.0.1:4317';
const namespaceA = 'u_' + 'a'.repeat(64), namespaceB = 'u_' + 'b'.repeat(64);
const initialRevision = 7;
const warning = '保存結果を確認できませんでした。保存された可能性があります。入力はこのページに残しています。本人確認後に入力を控え、別のタブで保存済みの内容を確認してから、必要な場合だけ保存してください。';
const conflict = '別の画面で更新されています。入力を控えてから再読み込みしてください。';
const saved = () => ({ people: [{ id: 'save-response-person', name: 'Saved synthetic friend', aliases: [], tags: [], notes: 'Saved synthetic note', color: '#4f5fcb' }], accounts: [] });
const initialState = () => ({ data: saved(), undo: [{ label: 'Meaningful synthetic prior edit', at: '2026-10-18T00:00:00Z', data: { people: [], accounts: [] } }] });
const importText = JSON.stringify({ format: 'daredakke', version: 1, data: { people: [{ ...saved().people[0], notes: 'Imported synthetic note' }], accounts: [] } }, null, 2);
const failures = [
  { title: '502 HTML', status: 502, contentType: 'text/html', body: '<html><body>Synthetic gateway response</body></html>' },
  { title: 'malformed 200', status: 200, contentType: 'application/json', body: '{' },
];
const fixtures = new WeakMap();
const recovery = page => page.getByRole('heading', { name: '保存結果を確認できませんでした', exact: true });
const retry = page => page.getByRole('button', { name: 'ログインを再確認する', exact: true });
const review = dialog => dialog.getByRole('region', { name: '読み込み内容の確認', exact: true });

async function start(page) {
  const api = { state: initialState(), revision: initialRevision, namespace: namespaceA, requests: [], posts: [], responses: [], nextSession: null, violations: [], errors: [], downloads: [] };
  fixtures.set(page, api);
  page.on('pageerror', error => api.errors.push(error.message));
  page.on('download', download => api.downloads.push(download.suggestedFilename()));
  await page.addInitScript(() => {
    // Observe native dispatch targets only; never alter propagation, clocks, or activation.
    const pointers = window.__saveResponsePointerEvents = { limit: 128, dropped: 0, events: [] };
    const describe = node => node instanceof Element ? {
      tag: node.tagName.toLowerCase(),
      id: node.id.slice(0, 80),
      role: (node.getAttribute('role') || '').slice(0, 32),
      state: (node.getAttribute('data-state') || '').slice(0, 16),
      pointerEvents: getComputedStyle(node).pointerEvents.slice(0, 16),
    } : null;
    const recordPointer = event => {
      pointers.events.push({
        sequence: pointers.dropped + pointers.events.length + 1,
        type: event.type, trusted: event.isTrusted, timeStamp: event.timeStamp,
        x: event.clientX, y: event.clientY, button: event.button,
        target: describe(event.target),
        path: event.composedPath().filter(node => node instanceof Element).slice(0, 12).map(describe),
      });
      if (pointers.events.length > pointers.limit) { pointers.events.shift(); pointers.dropped++; }
    };
    for (const type of ['pointerdown', 'click']) window.addEventListener(type, recordPointer, { capture: true, passive: true });
    const effects = window.__saveResponseEffects = { clipboard: [], blobs: [], storage: [] };
    window.__daredakkeTools = new Map();
    Object.defineProperty(document, 'modelContext', { configurable: true, value: {
      registerTool(tool) { window.__daredakkeTools.set(tool.name, tool); },
    } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      async writeText(text) { effects.clipboard.push(text); },
    } });
    URL.createObjectURL = blob => { effects.blobs.push(blob.size); return 'blob:synthetic-blocked-export'; };
    for (const method of ['setItem', 'removeItem', 'clear']) Storage.prototype[method] = function (...args) {
      effects.storage.push({ method, args });
      throw new Error('Synthetic drafts must not write Storage');
    };
  });
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin || (method !== 'GET' && !(method === 'POST' && url.pathname === '/api/records'))) {
      api.violations.push(`${method} ${url.origin}${url.pathname}${url.search}`);
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    api.requests.push({ method, path: url.pathname + url.search });
    if (url.pathname === '/api/session' && !url.search && method === 'GET') {
      const response = api.nextSession; api.nextSession = null;
      return route.fulfill(response || { json: { namespace: api.namespace } });
    }
    if (url.pathname === '/api/records' && method === 'GET' && url.searchParams.size === 1 && ['demo', 'personal'].includes(url.searchParams.get('scope'))) {
      return route.fulfill({ json: { namespace: api.namespace, revision: api.revision, state: api.state } });
    }
    if (url.pathname === '/api/records' && !url.search && method === 'POST') {
      const body = request.postDataJSON(); api.posts.push(body);
      const response = api.responses.shift();
      // Model the real optimistic-concurrency boundary, including a committed
      // write whose acknowledgment was lost. Replaying its old revision cannot
      // append a second record or a second history entry.
      if (body.expectedNamespace !== api.namespace) return route.fulfill({ status: 409, json: { code: 'identity_changed', error: 'Synthetic owner changed' } });
      if (body.revision !== api.revision) return route.fulfill({ status: 409, json: { error: conflict } });
      if (!response || response.commit) { api.state = structuredClone(body.state); api.revision++; }
      if (response) {
        const { title, commit, ...wire } = response;
        return route.fulfill(wire);
      }
      return route.fulfill({ json: { revision: api.revision } });
    }
    api.violations.push(`${method} ${url.pathname}${url.search}`);
    return route.abort();
  });
  await page.clock.install({ time: new Date('2026-10-19T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-19T00:00:01Z'));
  await page.goto('/');
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__daredakkeTools.has('search_friend_records'))).toBe(true);
  return api;
}

test.afterEach(async ({ page }, info) => {
  const api = fixtures.get(page);
  if (!api) return;
  try {
    expect(api.errors, 'The actual built UI must not throw').toEqual([]);
    expect(api.violations, 'Only exact-loopback static GETs and the synthetic API are allowed').toEqual([]);
    expect(api.downloads, 'Recovery must not download private records').toEqual([]);
    expect(await page.evaluate(() => window.__saveResponseEffects), 'Drafts stay in memory; no clipboard, export, or Storage writes').toEqual({ clipboard: [], blobs: [], storage: [] });
    for (const post of api.posts) {
      expect(post.scope).toBe('demo');
      expect(post.expectedNamespace).toBe(namespaceA);
      expect(post.revision, 'Unacknowledged writes never advance the client revision').toBe(initialRevision);
    }
  } finally {
    const pointers = await page.evaluate(() => window.__saveResponsePointerEvents ?? null).catch(() => null);
    await info.attach('synthetic-save-pointer-events', { body: JSON.stringify({ pointers }), contentType: 'application/json' });
  }
});

async function activate(control) {
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  // The virtual clock pauses animation frames, not the UI's permission checks.
  await control.click({ force: true });
}
async function tool(page, name = 'search_friend_records', input = { query: '' }) {
  return page.evaluate(async ({ name, input }) => {
    try { return { result: await window.__daredakkeTools.get(name).execute(input) }; }
    catch (error) { return { error: error.message }; }
  }, { name, input });
}
async function draft(page, kind) {
  let dialog, fields;
  if (kind === 'person') {
    await activate(page.locator('.collection-actions').getByRole('button', { name: '人を追加', exact: true }));
    dialog = page.getByRole('dialog', { name: '人を追加', exact: true });
    fields = [
      [dialog.getByLabel('名前 必須', { exact: true }), '  Unsaved synthetic friend  '],
      [dialog.getByLabel('別名', { exact: true }), 'Synthetic alias,  Second alias'],
      [dialog.getByLabel('タグ', { exact: true }), 'Synthetic tag、Second tag'],
      [dialog.getByRole('textbox', { name: 'メモ', exact: true }), 'Unsaved synthetic note\n  Exact second line  '],
    ];
  } else if (kind === 'account') {
    await activate(page.locator('.collection-actions').getByRole('button', { name: 'アカウントを追加', exact: true }));
    dialog = page.getByRole('dialog', { name: 'アカウントを追加', exact: true });
    await activate(dialog.getByRole('combobox', { name: '登録するサービス', exact: true }));
    await activate(page.getByRole('option', { name: 'X', exact: true }));
    await activate(dialog.getByRole('combobox', { name: 'アカウントの紐づけ先', exact: true }));
    await activate(page.getByRole('option', { name: 'Saved synthetic friend', exact: true }));
    fields = [
      [dialog.getByLabel('表示名', { exact: true }), '  Unsaved synthetic account  '],
      [dialog.getByLabel('プロフィールURL / ID 必須', { exact: true }), '@synthetic_user'],
    ];
  } else {
    await activate(page.getByRole('button', { name: 'JSONを読み込む', exact: true }));
    dialog = page.getByRole('dialog', { name: 'JSONを読み込む', exact: true });
    fields = [[dialog.getByRole('textbox', { name: 'JSON', exact: true }), importText]];
  }
  for (const [field, value] of fields) await field.fill(value);
  return { dialog, fields };
}
async function submit(page, kind, expected) {
  if (kind !== 'import') return activate(expected.dialog.getByRole('button', { name: '保存する', exact: true }));
  await activate(expected.dialog.getByRole('button', { name: '内容を確認して読み込む', exact: true }));
  await expect(review(expected.dialog)).toBeVisible();
  await activate(expected.dialog.getByRole('button', { name: '置き換えを確認する', exact: true }));
  await activate(page.getByRole('alertdialog').getByRole('button', { name: '置き換えて読み込む', exact: true }));
}
async function expectDraft(kind, expected) {
  await expect(expected.dialog).toBeVisible();
  for (const [field, value] of expected.fields) await expect(field).toHaveValue(value);
  if (kind === 'account') {
    await expect(expected.dialog.getByRole('combobox', { name: '登録するサービス', exact: true })).toHaveText('X');
    await expect(expected.dialog.getByRole('combobox', { name: 'アカウントの紐づけ先', exact: true })).toHaveText('Saved synthetic friend');
  }
  const action = expected.dialog.getByRole('button', { name: kind === 'import' ? '置き換えを確認する' : '保存する', exact: true });
  await expect(action).toBeVisible(); await expect(action).toBeEnabled();
  if (kind === 'import') await expect(review(expected.dialog)).toBeVisible();
}
async function blocked(page) {
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.locator('.person-row')).toHaveCount(0);
  await expect(page.getByText('Saved synthetic friend', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Saved synthetic note', { exact: true })).toHaveCount(0);
  for (const name of ['保存する', '人を追加', 'アカウントを追加', 'JSONを書き出す', 'JSONを読み込む', '元に戻す']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  expect((await tool(page)).error).toBe('ログイン確認中です。');
  expect((await tool(page, 'start_person_creation', {})).error).toBe('ログイン確認中です。');
}
async function noAutomaticRetry(page, api) {
  const before = structuredClone(api.requests);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(60000);
  expect(api.requests).toEqual(before);
  expect(api.posts).toHaveLength(1);
  await expect(recovery(page)).toBeVisible();
}
async function restore(page, api, kind, expected) {
  const before = structuredClone(api.requests);
  await activate(retry(page));
  await expectDraft(kind, expected);
  expect(api.requests).toEqual([...before, { method: 'GET', path: '/api/session' }]);
  expect(api.posts).toHaveLength(1);
  await expect(page.locator('.save-status')).toHaveText('保存状態を確認してください');
  await expect(expected.dialog.getByRole('alert')).toHaveText(warning);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect((await tool(page)).result.people.map(person => person.name)).toEqual(['Saved synthetic friend']);
  await expect(page.locator('.backup-tools button').filter({ hasText: '元に戻す' })).toHaveAttribute('title', 'Meaningful synthetic prior edit');
  const verified = structuredClone(api.requests);
  await page.clock.runFor(60000);
  expect(api.requests).toEqual(verified); expect(api.posts).toHaveLength(1);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expectDraft(kind, expected);
}

for (const kind of ['person', 'account', 'import']) for (const failure of failures) {
  test(`${kind} preserves exact input after ${failure.title} until explicit GET-only owner verification`, async ({ page }, info) => {
    const api = await start(page), expected = await draft(page, kind), before = structuredClone(api.state);
    api.responses.push(failure);
    await submit(page, kind, expected);
    await expect(recovery(page)).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText('保存された可能性があります。自動では再送しません。記録と入力は、本人の確認が済むまで表示しません。');
    await expect(retry(page)).toBeVisible();
    await blocked(page);
    if (kind === 'person' && failure.status === 502) await info.attach('synthetic-save-recovery', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
    await noAutomaticRetry(page, api);
    expect(api.state).toEqual(before); expect(api.revision).toBe(initialRevision);
    await restore(page, api, kind, expected);
    if (kind === 'person' && failure.status === 502) await info.attach('synthetic-save-restored-input', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
    // A restored JSON review must wait for a fresh deliberate final confirmation.
    if (kind === 'import') {
      await activate(expected.dialog.getByRole('button', { name: '置き換えを確認する', exact: true }));
      await expect(page.getByRole('alertdialog').getByRole('button', { name: '置き換えて読み込む', exact: true })).toBeEnabled();
      expect(api.posts).toHaveLength(1);
      await activate(page.getByRole('alertdialog').getByRole('button', { name: 'キャンセル', exact: true }));
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expectDraft(kind, expected);
    }
    expect(api.state).toEqual(before); expect(api.revision).toBe(initialRevision);
    expect(api.posts).toHaveLength(1);
  });
}

for (const failure of [
  { title: 'same revision', json: { revision: initialRevision } },
  { title: 'string revision', json: { revision: String(initialRevision + 1) } },
]) test(`nominal success with ${failure.title} is not a usable save acknowledgment`, async ({ page }) => {
  const api = await start(page), expected = await draft(page, 'person'), before = structuredClone(api.state);
  api.responses.push(failure);
  await submit(page, 'person', expected);
  await expect(recovery(page)).toBeVisible(); await blocked(page);
  await noAutomaticRetry(page, api);
  await restore(page, api, 'person', expected);
  expect(api.state).toEqual(before); expect(api.revision).toBe(initialRevision);
});

for (const rejection of [
  { title: 'different owner', response: { json: { namespace: namespaceB } } },
  { title: '401 HTML', response: { status: 401, contentType: 'text/html', body: '<html>Synthetic login required</html>' } },
  { title: '503 JSON', response: { status: 503, json: { error: 'Synthetic verification unavailable' } } },
]) test(`save recovery ${rejection.title} clears old person input and records`, async ({ page }) => {
  const api = await start(page), expected = await draft(page, 'person');
  api.responses.push(failures[0]);
  await submit(page, 'person', expected);
  await expect(recovery(page)).toBeVisible();
  api.nextSession = rejection.response;
  const before = structuredClone(api.requests);
  await activate(retry(page));
  await expect(page.getByRole('alert').filter({ hasText: 'ログイン' })).toBeVisible();
  expect(api.requests).toEqual([...before, { method: 'GET', path: '/api/session' }]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.person-row')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '人を追加', exact: true })).toBeDisabled();
  await expect(retry(page)).toHaveCount(0);
  expect((await tool(page)).error).toBe('ログイン確認中です。');
  await activate(page.getByRole('button', { name: /^(再読み込み|もう一度読み込む)$/ }));
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  // Opening a new editor never recovers another/expired owner's old draft.
  await activate(page.locator('.collection-actions').getByRole('button', { name: '人を追加', exact: true }));
  const fresh = page.getByRole('dialog', { name: '人を追加', exact: true });
  for (const label of ['名前 必須', '別名', 'タグ', 'メモ']) await expect(fresh.getByLabel(label, { exact: true })).toHaveValue('');
  expect(api.posts).toHaveLength(1);
});

for (const rejection of [
  { title: '401 HTML', status: 401, contentType: 'text/html', body: '<html>Synthetic login required</html>' },
  { title: '403 HTML', status: 403, contentType: 'text/html', body: '<html>Synthetic access denied</html>' },
  { title: '409 identity_changed', status: 409, json: { code: 'identity_changed', error: 'Synthetic login changed' } },
]) test(`real ${rejection.title} save rejection clears immediately rather than preserving input`, async ({ page }) => {
  const api = await start(page), expected = await draft(page, 'person');
  api.responses.push(rejection);
  await submit(page, 'person', expected);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(expected.dialog).toHaveCount(0);
  await expect(page.locator('.person-row')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '人を追加', exact: true })).toBeDisabled();
  await expect(recovery(page)).toHaveCount(0); await expect(retry(page)).toHaveCount(0);
  expect((await tool(page)).error).toBe('ログイン確認中です。');
  expect(api.posts).toHaveLength(1);
});

for (const rejection of [
  { title: '409 revision conflict', status: 409, json: { error: conflict } },
  { title: '503 JSON error', status: 503, json: { error: 'Synthetic save unavailable' } },
]) test(`${rejection.title} remains a normal save error without owner recovery`, async ({ page }) => {
  const api = await start(page), expected = await draft(page, 'person'), before = structuredClone(api.state);
  api.responses.push(rejection);
  await submit(page, 'person', expected);
  await expect(expected.dialog.getByRole('alert')).toHaveText(rejection.json.error);
  await expect(page.locator('.save-status')).toHaveText('保存状態を確認してください');
  await expectDraft('person', expected);
  await expect(recovery(page)).toHaveCount(0); await expect(retry(page)).toHaveCount(0);
  expect((await tool(page)).result.people.map(person => person.name)).toEqual(['Saved synthetic friend']);
  expect(api.posts).toHaveLength(1); expect(api.state).toEqual(before); expect(api.revision).toBe(initialRevision);
});

test('a stale person discard confirmation stays closed after save-result recovery', async ({ page }) => {
  const api = await start(page), expected = await draft(page, 'person');
  await activate(expected.dialog.getByRole('button', { name: 'キャンセル', exact: true }));
  await expect(page.getByRole('alertdialog').getByRole('button', { name: '入力を破棄する', exact: true })).toBeVisible();
  api.responses.push(failures[0]);
  // Exercise a queued form event from the old editor, not a click through the
  // modal. Recovery must close both confirmations without discarding input.
  await page.evaluate(() => document.querySelector('[role="dialog"] form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await expect(recovery(page)).toBeVisible(); await blocked(page);
  await noAutomaticRetry(page, api);
  await restore(page, api, 'person', expected);
  await page.clock.runFor(60000);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expectDraft('person', expected); expect(api.posts).toHaveLength(1);
});

test('committed malformed acknowledgment never auto-replays; explicit stale retry cannot duplicate records or history', async ({ page }) => {
  const api = await start(page), expected = await draft(page, 'person');
  api.responses.push({ ...failures[1], commit: true });
  await submit(page, 'person', expected);
  await expect(recovery(page)).toBeVisible();
  expect(api.posts).toHaveLength(1); expect(api.revision).toBe(initialRevision + 1);
  expect(api.state.data.people).toHaveLength(2); expect(api.state.undo).toHaveLength(2);
  const committed = structuredClone(api.state);
  await noAutomaticRetry(page, api);
  await restore(page, api, 'person', expected);
  const before = structuredClone(api.requests);
  await submit(page, 'person', expected);
  await expect(expected.dialog.getByRole('alert')).toHaveText(conflict);
  await expectDraft('person', expected);
  await expect(recovery(page)).toHaveCount(0);
  expect(api.requests).toEqual([...before, { method: 'POST', path: '/api/records' }]);
  expect(api.posts).toHaveLength(2);
  expect(api.posts.map(post => post.revision)).toEqual([initialRevision, initialRevision]);
  expect(api.posts.map(post => post.state.undo.length)).toEqual([2, 2]);
  expect(api.state).toEqual(committed); expect(api.revision).toBe(initialRevision + 1);
  expect(api.state.data.people.filter(person => person.name === 'Unsaved synthetic friend')).toHaveLength(1);
});
