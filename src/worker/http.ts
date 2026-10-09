export class HttpError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } }
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}
export async function readLimitedJson(request: Request, limit = 1000000): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new HttpError('保存容量の上限を超えています。', 413);
  if (!request.body) throw new HttpError('JSONを入力してください。', 400);
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > limit) { await reader.cancel(); throw new HttpError('保存容量の上限を超えています。', 413); } text += decoder.decode(part.value, { stream: true }); }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError('読み込めるJSONではありません。', 400); }
  finally { reader.releaseLock(); }
}
