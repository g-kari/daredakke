export type BundledAssets = Record<string, { body: string; contentType: string }>;
const allowedType = /^(?:text\/(?:html|css|javascript|plain)|application\/(?:javascript|json)|image\/svg\+xml)(?:; charset=utf-8)?$/;
export async function serveBundledAsset(request: Request, files: BundledAssets): Promise<Response> {
  const headers = new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  const reply = (body: string, status: number, type = 'text/plain; charset=utf-8') => {
    headers.set('Content-Type', type);
    headers.set('Content-Length', String(new TextEncoder().encode(body).byteLength));
    return new Response(request.method === 'HEAD' ? null : body, { status, headers });
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') { headers.set('Allow', 'GET, HEAD'); return reply('Method not allowed', 405); }
  const path = new URL(request.url).pathname;
  if (path.includes('%') || path.includes('\\') || path.split('/').some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) return reply('Not found', 404);
  let key = path === '/' ? '/index.html' : path;
  if (!Object.hasOwn(files, key)) {
    if (path.startsWith('/assets/') || path.includes('.')) return reply('Not found', 404);
    key = '/index.html';
  }
  if (!Object.hasOwn(files, key)) return reply('Not found', 404);
  const asset = files[key];
  if (!asset || typeof asset.body !== 'string' || typeof asset.contentType !== 'string' || !allowedType.test(asset.contentType)) return reply('Asset unavailable', 500);
  return reply(asset.body, 200, asset.contentType);
}
