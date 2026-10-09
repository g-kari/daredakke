import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { accessResolver } from './jwks-cache.ts';
import type { AuthConfig } from './config.ts';
export type Owner = { ownerId: 'owner'; subject: string };
export async function verifyOwnerToken(token: string | null, config: AuthConfig, key: JWTVerifyGetKey): Promise<Owner | null> {
  if (!token || token.length > 16384) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: config.issuer, audience: config.audience, algorithms: ['RS256'],
      requiredClaims: ['iss', 'aud', 'exp', 'iat', 'nbf', 'sub', 'email', 'type'], clockTolerance: 5,
    });
    if (payload.type !== 'app' || typeof payload.email !== 'string' || payload.email.toLowerCase() !== config.ownerEmail || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 200) return null;
    return { ownerId: 'owner', subject: payload.sub };
  } catch { return null; }
}
export async function authenticateOwner(request: Request, config: AuthConfig): Promise<Owner | null> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  // The endpoint is built only from configured, validated team domain, never JWT content or request headers.
  let keys: JWTVerifyGetKey;
  try { keys = accessResolver(config.issuer); } catch { return null; }
  return verifyOwnerToken(token, config, keys);
}
