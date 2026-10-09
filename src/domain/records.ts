export type Service = 'Discord' | 'X' | 'VRChat';
export type Person = { id: string; name: string; aliases: string[]; tags: string[]; notes: string; color: string };
export type Account = { id: string; service: Service; label: string; url: string; key: string; personId: string | null };
export type Data = { people: Person[]; accounts: Account[] };
export type Undo = { label: string; at: string; data: Data };
export type RecordState = { data: Data; undo: Undo[] };
export const colors = ['#4f5fcb', '#147d89', '#b35b4b', '#864caa', '#426a8a'];
export const empty = (): Data => ({ people: [], accounts: [] });
export function normalizeAccount(service: Service, raw: string): { url: string; key: string } {
  let value = raw.trim();
  if (!value || value.length > 500 || /[\s\u0000-\u001f]/.test(value)) throw new Error('アカウントURLまたはIDを確認してください。');
  if (service === 'X' && /^@?[a-zA-Z0-9_]{1,15}$/.test(value)) value = 'https://x.com/' + value.replace(/^@/, '');
  if (service === 'Discord' && /^\d{17,20}$/.test(value)) value = 'https://discord.com/users/' + value;
  if (service === 'VRChat' && /^usr_[a-f0-9-]{36}$/i.test(value)) value = 'https://vrchat.com/home/user/' + value;
  let u: URL; try { u = new URL(value); } catch { throw new Error('httpsのプロフィールURL、または対応するアカウントIDを入力してください。'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) throw new Error('httpsの通常のプロフィールURLだけ登録できます。');
  const host = u.hostname.toLowerCase().replace(/^www\./, ''), path = u.pathname.replace(/\/$/, '');
  if (service === 'X') {
    const m = path.match(/^\/([a-zA-Z0-9_]{1,15})$/);
    if (!['x.com', 'twitter.com'].includes(host) || !m || ['home', 'intent', 'search', 'explore', 'settings', 'messages', 'notifications', 'i'].includes(m[1].toLowerCase())) throw new Error('XのプロフィールURLまたはユーザー名を入力してください。');
    const key = m[1].toLowerCase(); return { url: 'https://x.com/' + key, key: 'X:' + key };
  }
  if (service === 'Discord') {
    const m = path.match(/^\/users\/(\d{17,20})$/);
    if (host !== 'discord.com' || !m) throw new Error('DiscordのユーザーID（17〜20桁）または /users/ID のURLを入力してください。');
    return { url: 'https://discord.com/users/' + m[1], key: 'Discord:' + m[1] };
  }
  const m = path.match(/^\/home\/user\/(usr_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
  if (host !== 'vrchat.com' || !m) throw new Error('VRChatのプロフィールURLまたは usr_ から始まるユーザーIDを入力してください。');
  return { url: 'https://vrchat.com/home/user/' + m[1].toLowerCase(), key: 'VRChat:' + m[1].toLowerCase() };
}
function text(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || value.length > max || /\u0000/.test(value)) throw new Error(field + 'の形式または長さが正しくありません。'); return value.trim();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSONの形式が正しくありません。'); return value as Record<string, unknown>;
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error(field + 'は20個までです。'); return [...new Set(value.map(v => text(v, 80, field)).filter(Boolean))];
}
export function validateData(raw: unknown): Data {
  const o = object(raw);
  if (!Array.isArray(o.people) || !Array.isArray(o.accounts) || o.people.length > 200 || o.accounts.length > 1000) throw new Error('人は200件、アカウントは1,000件まで登録できます。');
  const ids = new Set<string>();
  const people = o.people.map(value => {
    const p = object(value), id = text(p.id, 80, 'ID'), name = text(p.name, 100, '名前');
    if (!/^[\w-]{1,80}$/.test(id) || !name || id === 'none' || ids.has(id)) throw new Error('人のIDまたは名前が正しくありません。'); ids.add(id);
    return { id, name, aliases: strings(p.aliases, '別名'), tags: strings(p.tags, 'タグ'), notes: text(p.notes, 6000, 'メモ'), color: colors.includes(String(p.color)) ? String(p.color) : colors[0] };
  });
  const accountIds = new Set<string>();
  const accounts = o.accounts.map(value => {
    const a = object(value), id = text(a.id, 80, 'ID'), label = text(a.label, 100, '表示名');
    if (!/^[\w-]{1,80}$/.test(id) || accountIds.has(id) || typeof a.service !== 'string' || !['Discord', 'X', 'VRChat'].includes(a.service)) throw new Error('アカウントのIDまたはサービスが正しくありません。'); accountIds.add(id);
    const service = a.service as Service, normalized = normalizeAccount(service, text(a.url, 500, 'URL'));
    const personId = a.personId === null ? null : text(a.personId, 80, '紐づけ先');
    if (personId !== null && (!personId || !ids.has(personId))) throw new Error('存在しない人への紐づけがあります。'); return { id, service, label, ...normalized, personId };
  });
  return { people, accounts };
}
export function validateState(raw: unknown): RecordState {
  const o = object(raw), data = validateData(o.data);
  if (!Array.isArray(o.undo) || o.undo.length > 10) throw new Error('履歴の形式が正しくありません。');
  const undo = o.undo.map(value => { const u = object(value); return { label: text(u.label, 120, '履歴'), at: text(u.at, 40, '日時'), data: validateData(u.data) }; }); return { data, undo };
}
export function change(state: RecordState, data: Data, label: string): RecordState {
  const next = { data: validateData(data), undo: [{ label, at: new Date().toISOString(), data: state.data }, ...state.undo].slice(0, 10) };
  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 850000 || new TextEncoder().encode(exportData(next.data)).byteLength > 900000) throw new Error('保存容量の上限です。JSONを書き出して記録を整理してください。'); return next;
}
export function undoChange(state: RecordState): RecordState { return state.undo.length ? { data: state.undo[0].data, undo: state.undo.slice(1) } : state; }
export function mergePeople(data: Data, target: string, source: string): Data {
  const a = data.people.find(p => p.id === target), b = data.people.find(p => p.id === source);
  if (!a || !b || target === source) throw new Error('統合する2人を選んでください。');
  const merged = { ...a, aliases: [...new Set([...a.aliases, b.name, ...b.aliases])].filter(n => n !== a.name), tags: [...new Set([...a.tags, ...b.tags])], notes: [a.notes, b.notes].filter(Boolean).join('\n\n') };
  return validateData({ people: data.people.filter(p => p.id !== source).map(p => p.id === target ? merged : p), accounts: data.accounts.map(c => c.personId === source ? { ...c, personId: target } : c) });
}
export function duplicateGroups(data: Data): Account[][] {
  const map = new Map<string, Account[]>(); for (const a of data.accounts) map.set(a.key, [...(map.get(a.key) || []), a]); return [...map.values()].filter(group => group.length > 1);
}
export function parseImport(value: string): Data {
  if (new TextEncoder().encode(value).byteLength > 900000) throw new Error('JSONは900KBまでです。');
  let raw: unknown; try { raw = JSON.parse(value); } catch { throw new Error('読み込めるJSONではありません。'); }
  const o = object(raw); if (typeof o.format !== 'string' || !['friend-record', 'daredakke'].includes(o.format) || o.version !== 1) throw new Error('だれだっけ（旧フレンドレコード含む）のversion 1 JSONを選んでください。'); return validateData(o.data);
}
export function exportData(data: Data): string { return JSON.stringify({ format: 'daredakke', version: 1, exportedAt: new Date().toISOString(), data: validateData(data) }, null, 2); }
export function demoData(): Data {
  const people: Person[] = [
    { id: 'demo-aoi', name: 'あおい', aliases: ['Ao', 'あおちゃん'], tags: ['VRChat', 'ワールド制作'], notes: '架空のサンプル。ワールド制作の集まりで知り合った人、という想定。', color: colors[0] },
    { id: 'demo-sora', name: 'そら', aliases: ['Sora'], tags: ['ゲーム', 'Discord'], notes: '架空のサンプル。ゲーム仲間。週末によく話す、という想定。', color: colors[1] },
    { id: 'demo-yuki', name: 'ゆき', aliases: ['yuki_works'], tags: ['制作'], notes: '架空のサンプル。イラストを描く人、という想定。', color: colors[2] },
    { id: 'demo-ao', name: 'Ao（別記録）', aliases: [], tags: ['要確認'], notes: 'あおいと同じX URLが登録された例。自動で人を統合せず、自分で確かめます。', color: colors[3] },
  ];
  const make = (id: string, service: Service, input: string, label: string, personId: string | null): Account => ({ id, service, label, personId, ...normalizeAccount(service, input) });
  return { people, accounts: [make('demo-c1','Discord','100000000000000001','aoi_demo','demo-aoi'),make('demo-c2','X','fr_demo_aoi','@fr_demo_aoi','demo-aoi'),make('demo-c3','VRChat','usr_00000000-0000-4000-8000-000000000001','Aoi_demo','demo-aoi'),make('demo-c4','Discord','100000000000000002','sora_demo','demo-sora'),make('demo-c5','X','fr_demo_yuki','@fr_demo_yuki','demo-yuki'),make('demo-c6','X','https://twitter.com/FR_DEMO_AOI?ref=sample','Aoi（重複例）','demo-ao'),make('demo-c7','VRChat','usr_00000000-0000-4000-8000-000000000002','名前を確認したいアカウント',null)] };
}
