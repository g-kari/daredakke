import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const origin = 'http://127.0.0.1:4317';
const namespaceA = 'u_' + 'a'.repeat(64), namespaceB = 'u_' + 'b'.repeat(64);
const hundred = 'q'.repeat(100);
const fixtures = new WeakMap();
const blank = () => ({ people: [], accounts: [] });
const fixture = () => ({
  people: [
    { id: 'fixture-luna', name: 'ルナ', aliases: ['LUNA_demo'], tags: ['写真', 'ものづくり'], notes: 'Orbit workshop memo [night].+$ ' + hundred, color: '#4f5fcb' },
    { id: 'fixture-sora', name: 'そら', aliases: ['Sora_fixture'], tags: ['ゲーム'], notes: 'Weekend workshop note', color: '#147d89' },
    { id: 'fixture-yoru', name: 'よる', aliases: ['Yoru_fixture'], tags: ['写真'], notes: 'Night streaming', color: '#864caa' },
    { id: 'fixture-alone', name: 'アカウントなし', aliases: ['NoAccount_demo'], tags: ['写真'], notes: 'Standalone workshop', color: '#426a8a' },
  ],
  accounts: [
    { id: 'fixture-luna-discord', service: 'Discord', label: 'luna_voice', key: 'Discord:100000000000000001', url: 'https://discord.com/users/100000000000000001', personId: 'fixture-luna' },
    { id: 'fixture-luna-x', service: 'X', label: '@luna_demo [photo]', key: 'X:luna_fixture', url: 'https://x.com/luna_fixture', personId: 'fixture-luna' },
    { id: 'fixture-luna-vrc', service: 'VRChat', label: 'Luna Worlds', key: 'VRChat:usr_00000000-0000-4000-8000-000000000001', url: 'https://vrchat.com/home/user/usr_00000000-0000-4000-8000-000000000001', personId: 'fixture-luna' },
    { id: 'fixture-sora-discord', service: 'Discord', label: 'sora_game', key: 'Discord:100000000000000002', url: 'https://discord.com/users/100000000000000002', personId: 'fixture-sora' },
    { id: 'fixture-yoru-x', service: 'X', label: 'Yoru stream', key: 'X:yoru_fixture', url: 'https://x.com/yoru_fixture', personId: 'fixture-yoru' },
    { id: 'fixture-duplicate', service: 'X', label: '@other_echo', key: 'X:luna_fixture', url: 'https://x.com/luna_fixture', personId: null },
    { id: 'fixture-nebula', service: 'X', label: 'Nebula Signal [draft].+$', key: 'X:nebula_fixture', url: 'https://x.com/nebula_fixture', personId: null },
    { id: 'fixture-garden', service: 'VRChat', label: 'Unknown Garden', key: 'VRChat:usr_00000000-0000-4000-8000-000000000002', url: 'https://vrchat.com/home/user/usr_00000000-0000-4000-8000-000000000002', personId: null },
  ],
});
const names = ['ルナ', 'そら', 'よる', 'アカウントなし'];
const queries = [
  ['ルナ 写真 workshop luna_voice', ['ルナ']],
  ['LUNA_VOICE WORKSHOP 写真 ルナ', ['ルナ']],
  ['  ルナ   写真\u3000\u3000workshop\tluna_voice  ', ['ルナ']],
  ['LUNA_DEMO 写真', ['ルナ']],
  ['写真 orbit', ['ルナ']],
  ['写真 luna_fixture', ['ルナ']],
  ['写真 100000000000000001', ['ルナ']],
  ['写真 VRCHAT', ['ルナ']],
  ['[night].+$ ルナ', ['ルナ']],
  ['ルナ .*$missing', []],
  ['ルナ sora_game', []],
  ['写真', ['ルナ', 'よる', 'アカウントなし']],
  ['workshop', ['ルナ', 'そら', 'アカウントなし']],
  ['', names],
  [' \u3000 \t ', names],
];

async function start(page, demo = fixture(), personal = blank()) {
  const api = { namespace: namespaceA, states: { demo: { data: demo, undo: [] }, personal: { data: personal, undo: [] } }, requests: [], violations: [], errors: [], sessionGate: null };
  api.initial = JSON.stringify(api.states);
  fixtures.set(page, api);
  page.on('pageerror', error => api.errors.push(error.message));
  // Only the same registration fixture used by unsaved-input.spec.mjs is
  // simulated. This does not test native WebMCP browser interoperability.
  await page.addInitScript(() => {
    window.__daredakkeTools = new Map();
    Object.defineProperty(document, 'modelContext', { configurable: true, value: {
      registerTool(tool) { window.__daredakkeTools.set(tool.name, tool); },
    } });
  });
  // One route enforces origin and method before returning synthetic API data.
  // A denied external/API mutation is never continued to the real service.
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || request.method() !== 'GET') {
      api.violations.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    api.requests.push({ path: url.pathname, scope: url.searchParams.get('scope') });
    if (url.pathname === '/api/session' && !url.search) {
      if (api.sessionGate) {
        const gate = api.sessionGate;
        api.sessionGate = null;
        await gate.promise;
      }
      return route.fulfill({ json: { namespace: api.namespace } });
    }
    const scope = url.searchParams.get('scope');
    if (url.pathname === '/api/records' && ['demo', 'personal'].includes(scope) && url.searchParams.size === 1) {
      return route.fulfill({ json: { namespace: api.namespace, revision: 0, state: api.states[scope] } });
    }
    api.violations.push('Unexpected local API request: ' + url.pathname + url.search);
    return route.abort();
  });
  api.pauseNextSession = () => {
    let release;
    api.sessionGate = { promise: new Promise(resolve => { release = resolve; }) };
    return release;
  };
  await page.goto('/');
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__daredakkeTools.has('search_friend_records'))).toBe(true);
  return api;
}

test.afterEach(async ({ page }) => {
  const api = fixtures.get(page);
  if (!api) return;
  expect(api.violations, 'All requests must be GET on the exact loopback origin').toEqual([]);
  expect(api.errors, 'The actual built UI must not throw').toEqual([]);
  expect(JSON.stringify(api.states), 'Search must not mutate the synthetic saved records').toBe(api.initial);
});

const search = page => page.getByRole('textbox', { name: '記録を検索', exact: true });
async function expectNames(page, expected) {
  await expect(page.locator('.person-row')).toHaveCount(expected.length);
  await expect.poll(() => page.locator('.person-row').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')))).toEqual(expected.map(name => name + 'の記録を開く'));
}
async function tool(page, input) {
  return page.evaluate(async input => {
    try { return { result: await window.__daredakkeTools.get('search_friend_records').execute(input) }; }
    catch (error) { return { error: error.message }; }
  }, input);
}
async function screenshot(page, info, label) {
  await mkdir('test-results/keyword-search', { recursive: true });
  const path = `test-results/keyword-search/${info.project.name}-${label}.png`;
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach('keyword-search-' + label, { path, contentType: 'image/png' });
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test('multi-clue people lookup is literal case-insensitive AND across existing fields', async ({ page }, info) => {
  await start(page);
  await expect(search(page)).toHaveAttribute('maxlength', '100');
  await expect(search(page)).toHaveAttribute('aria-describedby', 'record-search-hint');
  await expect(search(page)).toHaveAccessibleDescription('空白で区切ると、すべてのキーワードで絞り込めます。');
  await expect(page.locator('#record-search-hint')).toBeVisible();
  for (const [query, expected] of queries) {
    await search(page).fill(query);
    await expectNames(page, expected);
  }
  await search(page).fill('ルナ 写真 workshop luna_voice');
  await noOverflow(page);
  await screenshot(page, info, 'multi-clue-list');
});

test('service filters preserve multi-clue selection empty states and keyboard focus', async ({ page }, info) => {
  await start(page);
  await page.getByRole('button', { name: 'Discord', exact: true }).click();
  // Service membership remains a separate filter: another linked service's
  // account URL can supply a clue for a person who also has Discord.
  await search(page).fill('写真 luna_fixture');
  await expectNames(page, ['ルナ']);
  // Keep the row locator valid while the mobile modal makes its background
  // inaccessible, so its selected state can still be inspected.
  const row = page.locator('.person-row[aria-label="ルナの記録を開く"]');
  await row.focus();
  await page.keyboard.press('Enter');
  const profile = info.project.use.isMobile ? page.getByRole('dialog', { name: 'ルナ', exact: true }) : page.getByRole('article', { name: 'ルナのプロフィール', exact: true });
  await expect(profile.getByRole('heading', { name: 'メモ', exact: true })).toBeVisible();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await noOverflow(page);
  await screenshot(page, info, 'selected-profile');
  if (info.project.use.isMobile) {
    await page.keyboard.press('Escape');
    await expect(profile).toHaveCount(0);
    await expect(row).toBeFocused();
  }
  await search(page).fill('sora_game workshop');
  await expectNames(page, ['そら']);
  if (!info.project.use.isMobile) await expect(page.getByRole('article', { name: 'そらのプロフィール', exact: true })).toBeVisible();
  await search(page).fill('よる 写真');
  await expectNames(page, []);
  await expect(page.getByText('一致する人がいません', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'X', exact: true }).click();
  await expectNames(page, ['よる']);
  await search(page).fill(' \u3000 ');
  await expectNames(page, ['ルナ', 'よる']);
  await page.getByRole('button', { name: 'すべて', exact: true }).click();
  await expectNames(page, names);
});

test('unresolved and duplicate filters require all clues on one existing account row', async ({ page }, info) => {
  await start(page);
  await page.getByRole('tab', { name: '未整理' }).click();
  const unresolved = page.locator('.workspace-detail .account-row');
  for (const query of ['Nebula [draft].+$', '[draft].+$\u3000NEBULA', 'nebula_fixture X']) {
    await search(page).fill(query);
    await expect(unresolved).toHaveCount(1);
    await expect(unresolved.getByText('Nebula Signal [draft].+$', { exact: true })).toBeVisible();
  }
  await search(page).fill('Nebula VRChat');
  await expect(unresolved).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '一致する未整理アカウントがありません', exact: true })).toBeVisible();
  await search(page).fill(' \u3000 ');
  await expect(unresolved).toHaveCount(3);
  await page.getByRole('button', { name: 'VRChat', exact: true }).click();
  await expect(unresolved).toHaveCount(1);
  await page.getByRole('button', { name: 'すべて', exact: true }).click();
  await page.getByRole('tab', { name: '重複候補' }).click();
  const duplicates = page.locator('.duplicate-card');
  for (const query of ['ルナ [photo]', '[photo]\u3000ルナ', 'luna_fixture X']) {
    await search(page).fill(query);
    await expect(duplicates).toHaveCount(1);
    await expect(duplicates.locator('.duplicate-owners>div')).toHaveCount(2);
  }
  // The owner's name and the other row's label must not combine across rows.
  await search(page).fill('ルナ other_echo');
  await expect(duplicates).toHaveCount(0);
  await search(page).fill('写真'); // Person tags are not an account-row field.
  await expect(duplicates).toHaveCount(0);
  await search(page).fill('luna_fixture X');
  await page.getByRole('button', { name: 'Discord', exact: true }).click();
  await expect(duplicates).toHaveCount(0);
  await page.getByRole('button', { name: 'X', exact: true }).click();
  await expect(duplicates).toHaveCount(1);
  await noOverflow(page);
  await screenshot(page, info, 'duplicate-clues');
});

test('simulated WebMCP results match UI people fields order and repeated calls without writes', async ({ page }) => {
  const api = await start(page);
  const initialRequests = api.requests.length;
  for (const [query, expected] of queries) {
    await search(page).fill(query);
    await expectNames(page, expected);
    await page.getByRole('button', { name: 'Discord', exact: true }).click();
    await page.getByRole('tab', { name: '未整理' }).click();
    for (let repeat = 0; repeat < 2; repeat++) {
      const answer = await tool(page, { query });
      expect(answer.error).toBeUndefined();
      expect(answer.result.people.map(person => person.name)).toEqual(expected);
      expect(answer.result.people.map(person => person.id)).toEqual(fixture().people.filter(person => expected.includes(person.name)).map(person => person.id));
      for (const person of answer.result.people) expect(person.accounts).toEqual(fixture().accounts.filter(account => account.personId === person.id));
      await expect(search(page)).toHaveValue(query);
      await expect(page.getByRole('tab', { name: '人', exact: false }).first()).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('button', { name: 'すべて', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expectNames(page, expected);
    }
  }
  expect(api.requests).toHaveLength(initialRequests);
  const metadata = await page.evaluate(() => {
    const current = window.__daredakkeTools.get('search_friend_records');
    return { schema: current.inputSchema, annotations: current.annotations };
  });
  expect(metadata.schema.properties.query.maxLength).toBe(100);
  expect(metadata.schema.additionalProperties).toBe(false);
  expect(metadata.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
});

test('search retains the existing 100-character UI and WebMCP input boundary', async ({ page }) => {
  await start(page);
  await search(page).fill(hundred);
  await expectNames(page, ['ルナ']);
  expect((await tool(page, { query: hundred })).result.people.map(person => person.name)).toEqual(['ルナ']);
  await search(page).fill(hundred + 'q');
  await expect(search(page)).toHaveValue(hundred);
  for (const input of [{ query: hundred + 'q' }, { query: 1 }, { query: null }, {}, null, [], { query: 'ルナ', extra: true }]) {
    expect((await tool(page, input)).error).toBe('queryは100文字までの文字列です。');
    await expect(search(page)).toHaveValue(hundred);
    await expectNames(page, ['ルナ']);
  }
});

for (const kind of ['person', 'account', 'import']) {
  test(`repeated simulated search preserves unsaved ${kind} input and dismissal protection`, async ({ page }) => {
    await start(page);
    let editor, field, value;
    if (kind === 'person') {
      await page.getByRole('button', { name: '人を追加', exact: true }).click();
      editor = page.getByRole('dialog', { name: '人を追加', exact: true });
      await editor.getByLabel('名前 必須', { exact: true }).fill('Unsaved synthetic friend');
      field = editor.getByRole('textbox', { name: 'メモ', exact: true });
      value = 'Unsaved synthetic note';
    } else if (kind === 'account') {
      await page.locator('.collection-actions').getByRole('button', { name: 'アカウントを追加', exact: true }).click();
      editor = page.getByRole('dialog', { name: 'アカウントを追加', exact: true });
      await editor.getByLabel('表示名', { exact: true }).fill('Unsaved synthetic account');
      field = editor.getByLabel('プロフィールURL / ID 必須', { exact: true });
      value = '100000000000000099';
    } else {
      await page.getByRole('button', { name: 'JSONを読み込む', exact: true }).click();
      editor = page.getByRole('dialog', { name: 'JSONを読み込む', exact: true });
      field = editor.getByRole('textbox', { name: 'JSON', exact: true });
      value = JSON.stringify({ format: 'daredakke', version: 1, data: blank() });
    }
    await field.fill(value);
    await field.focus();
    for (const query of ['ルナ 写真', '写真 ルナ', ' \u3000 ']) {
      expect((await tool(page, { query })).error).toBeUndefined();
      await expect(field).toHaveValue(value);
      await expect(field).toBeFocused();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
    }
    await page.keyboard.press('Escape');
    const confirmation = page.getByRole('alertdialog');
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole('button', { name: '編集を続ける', exact: true })).toBeFocused();
    await confirmation.getByRole('button', { name: '編集を続ける', exact: true }).click();
    await expect(field).toHaveValue(value);
    await expect(field).toBeFocused();
    await page.keyboard.press('Escape');
    await confirmation.getByRole('button', { name: '入力を破棄する', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expectNames(page, names);
  });
}

test('search tools stay within the loaded demo or personal scope', async ({ page }) => {
  const personal = { people: [{ id: 'fixture-personal', name: 'マイ架空', aliases: ['Personal_fixture'], tags: ['写真'], notes: 'Scope-only synthetic note', color: '#426a8a' }], accounts: [] };
  const api = await start(page, fixture(), personal);
  expect((await tool(page, { query: 'ルナ 写真' })).result.people.map(person => person.name)).toEqual(['ルナ']);
  await page.getByRole('button', { name: 'マイレコード', exact: true }).click();
  await expect(page.getByText('自分の記録', { exact: true })).toBeVisible();
  await expectNames(page, ['マイ架空']);
  await expect(search(page)).toHaveValue('');
  expect((await tool(page, { query: 'ルナ 写真' })).result.people).toEqual([]);
  expect((await tool(page, { query: '写真 personal_FIXTURE' })).result.people.map(person => person.name)).toEqual(['マイ架空']);
  await page.getByRole('button', { name: 'デモ', exact: true }).click();
  await expectNames(page, names);
  expect((await tool(page, { query: 'personal_fixture 写真' })).result.people).toEqual([]);
  // React StrictMode may start and abort an extra initial GET. Require the
  // ordered scope transitions without treating a repeated same-scope GET as
  // a mutation or relying on whether its abort wins the browser dispatch.
  const scopes = api.requests.filter(request => request.path === '/api/records').map(request => request.scope);
  expect(scopes.filter((scope, index) => index === 0 || scope !== scopes[index - 1])).toEqual(['demo', 'personal', 'demo']);
});

test('empty scopes retain initial empty-state wording for whitespace-only queries', async ({ page }) => {
  await start(page, blank());
  await page.getByRole('button', { name: 'マイレコード', exact: true }).click();
  await expect(page.getByText('自分の記録', { exact: true })).toBeVisible();
  await expect(search(page)).toHaveValue('');
  await expect(page.getByText('人の記録はまだありません', { exact: true })).toBeVisible();
  await search(page).fill(' \u3000\t ');
  await expect(page.getByText('人の記録はまだありません', { exact: true })).toBeVisible();
  await expect(page.getByText('一致する人がいません', { exact: true })).toHaveCount(0);
  expect((await tool(page, { query: ' \u3000 ' })).result.people).toEqual([]);
  await page.getByRole('tab', { name: '未整理' }).click();
  await expect(page.getByRole('heading', { name: '未整理アカウントはありません', exact: true })).toBeVisible();
});

test('pending session checks reject tool lookup and owner changes clear old results and drafts', async ({ page }) => {
  const api = await start(page);
  expect((await tool(page, { query: 'ルナ 写真' })).result.people.map(person => person.name)).toEqual(['ルナ']);
  await page.getByRole('button', { name: '人を追加', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '人を追加', exact: true });
  await editor.getByLabel('名前 必須', { exact: true }).fill('Old synthetic session draft');
  const release = api.pauseNextSession();
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('status')).toHaveText('ログインを確認しています…');
    expect((await tool(page, { query: 'ルナ 写真' })).error).toBe('ログイン確認中です。');
    api.namespace = namespaceB;
  } finally { release(); }
  await expect(page.getByRole('alert').filter({ hasText: 'ログイン' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectNames(page, []);
  expect((await tool(page, { query: '' })).result.people).toEqual([]);
  await expect(search(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: '人を追加', exact: true })).toBeDisabled();
});
