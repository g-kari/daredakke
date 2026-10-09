import { readAuthConfig } from './config.ts';
import { authenticateOwner } from './auth.ts';
import { handleRecords } from './records-api.ts';
import { json } from './http.ts';
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const config = readAuthConfig(env);
      if (!config) return json({ error: '本人専用の認証設定が未完了です。', code: 'auth_not_configured' }, 503);
      if (new URL(request.url).origin !== config.origin) return json({ error: 'このURLにはアクセスできません。' }, 403);
      const owner = await authenticateOwner(request, config);
      if (!owner) return json({ error: '所有者のCloudflare Accessログインが必要です。' }, 401);
      const path = new URL(request.url).pathname;
      if (path === '/api/session') return request.method === 'GET' ? json({ namespace: owner.ownerId }) : json({ error: 'この操作には対応していません。' }, 405);
      if (path === '/api/records') return await handleRecords(request, env.DB, owner, config);
      if (path.startsWith('/api/')) return json({ error: '見つかりません。' }, 404);
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'この操作には対応していません。' }, 405);
      const asset = await env.ASSETS.fetch(request), response = new Response(asset.body, asset);
      response.headers.set('X-Content-Type-Options', 'nosniff'); response.headers.set('Referrer-Policy', 'no-referrer'); response.headers.set('X-Robots-Tag', 'noindex, nofollow');
      if (response.headers.get('content-type')?.includes('text/html')) response.headers.set('Cache-Control', 'private, no-store');
      return response;
    } catch { console.error(JSON.stringify({ event: 'request_failed' })); return json({ error: '現在このサイトを利用できません。' }, 503); }
  },
} satisfies ExportedHandler<Env>;
