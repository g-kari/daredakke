import { demoData, empty, validateState } from '../domain/records.ts';
import { HttpError, json, readLimitedJson } from './http.ts';
import type { AuthConfig } from './config.ts';
import type { Owner } from './auth.ts';
export async function handleRecords(request: Request, db: D1Database, owner: Owner, config: AuthConfig): Promise<Response> {
  if (request.method === 'GET') {
    const scope = new URL(request.url).searchParams.get('scope');
    if (scope !== 'demo' && scope !== 'personal') return json({ error: '保存先を確認してください。' }, 400);
    try {
      const initial = { data: scope === 'demo' ? demoData() : empty(), undo: [] };
      await db.prepare('INSERT OR IGNORE INTO record_documents (owner_id, scope, document, revision, updated_at) VALUES (?, ?, ?, 0, ?)').bind(owner.ownerId, scope, JSON.stringify(initial), new Date().toISOString()).run();
      const row = await db.prepare('SELECT document, revision FROM record_documents WHERE owner_id = ? AND scope = ?').bind(owner.ownerId, scope).first<{ document: string; revision: number }>();
      if (!row) throw new Error('missing_document');
      return json({ state: validateState(JSON.parse(row.document)), revision: row.revision });
    } catch { console.error(JSON.stringify({ event: 'record_read_failed' })); return json({ error: '保存データを読み込めませんでした。再読み込みしてください。' }, 503); }
  }
  if (request.method !== 'POST') return json({ error: 'この操作には対応していません。' }, 405);
  if (request.headers.get('origin') !== config.origin || request.headers.get('x-friend-record') !== '1' || !request.headers.get('content-type')?.startsWith('application/json') || request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'この画面から保存してください。' }, 403);
  let payload: Record<string, unknown>, state;
  try {
    const raw = await readLimitedJson(request);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError('保存情報を確認してください。', 400);
    payload = raw as Record<string, unknown>;
    if ((payload.scope !== 'demo' && payload.scope !== 'personal') || typeof payload.revision !== 'number' || !Number.isSafeInteger(payload.revision) || payload.revision < 0) throw new HttpError('保存情報を確認してください。', 400);
    state = validateState(payload.state);
    if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 850000) throw new HttpError('履歴を含む保存容量の上限です。', 413);
  } catch (error) { return json({ error: error instanceof Error ? error.message : '保存情報を確認してください。' }, error instanceof HttpError ? error.status : 400); }
  try {
    const result = await db.prepare('UPDATE record_documents SET document = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND scope = ? AND revision = ?').bind(JSON.stringify(state), new Date().toISOString(), owner.ownerId, payload.scope, payload.revision).run();
    if (result.meta.changes !== 1) return json({ error: '別の画面で更新されています。入力を控えてから再読み込みしてください。' }, 409);
    return json({ revision: Number(payload.revision) + 1 });
  } catch { console.error(JSON.stringify({ event: 'record_save_failed' })); return json({ error: '保存できませんでした。入力は画面に残っています。時間を置いてもう一度保存してください。' }, 503); }
}
