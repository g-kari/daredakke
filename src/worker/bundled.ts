import app from './index.ts';
import files from '../../.generated/static-assets.generated.json' with { type: 'json' };
import { serveBundledAsset } from './bundled-assets.ts';
type BundledEnv = Omit<Env, 'ASSETS'>;
export default {
  fetch(request: Request, env: BundledEnv): Promise<Response> {
    // All routing, including static files, still enters the original owner-authenticated app first.
    return app.fetch(request, { ...env, ASSETS: { fetch: assetRequest => serveBundledAsset(assetRequest, files) } });
  },
} satisfies ExportedHandler<BundledEnv>;
