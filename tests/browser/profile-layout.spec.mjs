import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const namespace = 'u_' + 'a'.repeat(64);
const fixture = () => ({
  people: [
    { id: 'sora', name: 'そら', aliases: ['sora_demo'], tags: ['VRChat', 'ものづくり'], notes: '週末のワールド巡りで会った人。音楽と写真が好き。', color: '#4f5fcb' },
    { id: 'haku', name: 'はく', aliases: ['haku_demo'], tags: ['ゲーム'], notes: '一緒に遊ぶゲーム仲間。', color: '#147d89' },
    { id: 'nagi', name: 'なぎ', aliases: ['nagi_demo'], tags: ['写真'], notes: '写真の話でよく盛り上がる。', color: '#426a8a' },
    { id: 'yoru', name: 'よる', aliases: ['yoru_demo'], tags: ['配信'], notes: '配信でよく見かける人。', color: '#864caa' },
  ],
  accounts: [
    { id: 'discord-sora', service: 'Discord', label: 'sora_demo', key: 'Discord:100000000000000001', url: 'https://discord.com/users/100000000000000001', personId: 'sora' },
    { id: 'x-sora', service: 'X', label: '@sora_demo', key: 'X:sora_demo', url: 'https://x.com/sora_demo', personId: 'sora' },
    { id: 'vrc-sora', service: 'VRChat', label: 'sora_demo', key: 'VRChat:usr_00000000-0000-4000-8000-000000000001', url: 'https://vrchat.com/home/user/usr_00000000-0000-4000-8000-000000000001', personId: 'sora' },
    { id: 'discord-haku', service: 'Discord', label: 'haku_demo', key: 'Discord:100000000000000002', url: 'https://discord.com/users/100000000000000002', personId: 'haku' },
    { id: 'duplicate', service: 'X', label: 'sora_demo', key: 'X:sora_demo', url: 'https://x.com/sora_demo', personId: null },
    { id: 'unknown1', service: 'X', label: 'sample_one', key: 'X:sample_one', url: 'https://x.com/sample_one', personId: null },
    { id: 'unknown2', service: 'VRChat', label: 'sample_two', key: 'VRChat:usr_00000000-0000-4000-8000-000000000002', url: 'https://vrchat.com/home/user/usr_00000000-0000-4000-8000-000000000002', personId: null },
  ],
});
async function start(page, data = fixture()) {
  const api = { revision: 0, state: { data, undo: [] }, posts: [], errors: [] };
  page.on('pageerror', e => api.errors.push(e.message));
  await page.context().route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:4317' ? route.continue() : route.abort());
  await page.context().route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/session') return route.fulfill({ json: { namespace } });
    if (url.pathname !== '/api/records') throw new Error('Unexpected API request');
    if (route.request().method() === 'POST') { const body = route.request().postDataJSON(); api.posts.push(body); api.state = body.state; api.revision++; return route.fulfill({ json: { revision: api.revision } }); }
    return route.fulfill({ json: { namespace, revision: api.revision, state: api.state } });
  });
  await page.goto('/'); await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  return api;
}
async function select(page, info, name) {
  await page.getByRole('button', { name: name + 'の記録を開く', exact: true }).click();
  return info.project.use.isMobile ? page.getByRole('dialog', { name }) : page.getByRole('article', { name: name + 'のプロフィール' });
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test('B2-4 list and profile preserve actual content and global scope once', async ({ page }, info) => {
  const api = await start(page);
  await expect(page.getByText('架空データ', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '人を追加', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'JSONを書き出す', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'JSONを読み込む', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'すべて', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await noOverflow(page);
  await mkdir('test-results/ui', { recursive: true });
  await page.screenshot({ path: `test-results/ui/${info.project.name}-list.png`, fullPage: true, animations: 'disabled' });
  const profile = await select(page, info, 'そら');
  await expect(profile.getByText('週末のワールド巡りで会った人。音楽と写真が好き。', { exact: true })).toBeVisible();
  await expect(profile.getByRole('heading', { name: 'メモ', exact: true })).toBeVisible();
  await expect(profile.getByRole('heading', { name: '別名', exact: true })).toBeVisible();
  await expect(profile.getByRole('heading', { name: 'アカウント', exact: true })).toBeVisible();
  await expect(profile.locator('.account-row')).toHaveCount(3);
  await expect(profile.getByRole('link')).toHaveCount(0); // demo must never open external profiles.
  await noOverflow(page);
  await page.screenshot({ path: `test-results/ui/${info.project.name}-profile.png`, fullPage: true, animations: 'disabled' });
  expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('search and service filters keep selection and empty states accurate', async ({ page }, info) => {
  const api = await start(page);
  await page.getByRole('button', { name: 'Discord', exact: true }).click();
  await expect(page.getByRole('button', { name: 'そらの記録を開く', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'はくの記録を開く', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'なぎの記録を開く', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: '記録を検索' }).fill('haku_demo');
  await expect(page.locator('.person-row')).toHaveCount(1);
  const profile = await select(page, info, 'はく');
  await expect(profile.getByText('一緒に遊ぶゲーム仲間。', { exact: true })).toBeVisible();
  if (info.project.use.isMobile) {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'はくの記録を開く', exact: true })).toBeFocused();
  }
  await page.getByRole('textbox', { name: '記録を検索' }).fill('no_fixture_match');
  await expect(page.locator('.person-row')).toHaveCount(0);
  await expect(page.getByText('一致する人がいません', { exact: true })).toBeVisible();
  await noOverflow(page); expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('contextual account creation and profile edits remain correctly attached', async ({ page }, info) => {
  const api = await start(page); const profile = await select(page, info, 'そら');
  await profile.getByRole('button', { name: 'アカウントを追加', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'アカウントを追加', exact: true });
  await expect(editor.getByRole('combobox', { name: 'アカウントの紐づけ先' })).toHaveText('そら');
  await editor.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await profile.getByRole('button', { name: '編集', exact: true }).click();
  const personEditor = page.getByRole('dialog', { name: '人の記録を編集', exact: true });
  await personEditor.getByRole('textbox', { name: 'メモ', exact: true }).fill('Updated synthetic note');
  await personEditor.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(personEditor).toHaveCount(0);
  await expect(profile.getByText('Updated synthetic note', { exact: true })).toBeVisible();
  expect(api.posts).toHaveLength(1); expect(api.posts[0].state.data.people.find(p => p.id === 'sora').notes).toBe('Updated synthetic note');
  expect(api.errors).toEqual([]);
});

test('unresolved linking duplicate inspection backup and undo remain available', async ({ page }, info) => {
  const api = await start(page);
  await page.getByRole('tab', { name: '未整理' }).click();
  await expect(page.locator('.workspace-detail .account-row')).toHaveCount(3);
  await page.getByRole('tab', { name: '重複候補' }).click();
  await expect(page.locator('.duplicate-card')).toHaveCount(1);
  await page.locator('.duplicate-card').getByRole('button', { name: '記録を確認', exact: true }).first().click();
  const profile = info.project.use.isMobile ? page.getByRole('dialog', { name: 'そら' }) : page.getByRole('article', { name: 'そらのプロフィール' });
  await expect(profile.getByRole('heading', { name: 'メモ', exact: true })).toBeVisible();
  if (info.project.use.isMobile) await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '保存・バックアップ' }).click();
  await expect(page.getByRole('heading', { name: 'サービス連携', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'JSONを書き出す', exact: true }).click();
  const exported = JSON.parse(await page.getByRole('textbox', { name: '書き出しJSON' }).inputValue());
  expect(exported.data.people).toHaveLength(4); expect(exported.data.accounts).toHaveLength(7);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '元に戻す', exact: true })).toBeDisabled();
  await noOverflow(page); expect(api.posts).toHaveLength(0); expect(api.errors).toEqual([]);
});

test('long names aliases notes and handles fit desktop mobile and medium widths', async ({ page }, info) => {
  const data = fixture(); data.people[0].name = '長い名前'.repeat(20); data.people[0].aliases = ['long_alias_'.repeat(7)]; data.people[0].tags = ['タグ'.repeat(30)]; data.people[0].notes = '長いメモと記録。'.repeat(100);
  const api = await start(page, data); await select(page, info, data.people[0].name); await noOverflow(page);
  if (!info.project.use.isMobile) { await page.setViewportSize({ width: 900, height: 900 }); await noOverflow(page); }
  expect(api.errors).toEqual([]);
});
