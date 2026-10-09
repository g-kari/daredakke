import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { accessResolver } from './jwks-cache.ts';
import { normalizeAccessIssuer, type AuthConfig } from './config.ts';
export type Owner = { ownerId: string; subject: string };
export async function ownerNamespace(issuer: string, subject: string): Promise<string> {
  const normalized = normalizeAccessIssuer(issuer);
  if (!normalized || !subject.trim() || subject.length > 200) throw new Error('invalid_identity');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([normalized, subject])));
  return 'u_' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function verifyOwnerToken(token: string | null, config: AuthConfig, key: JWTVerifyGetKey): Promise<Owner | null> {
  if (!token || token.length > 16384) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: config.issuer, audience: config.audience, algorithms: ['RS256'],
      requiredClaims: ['iss', 'aud', 'exp', 'iat', 'nbf', 'sub', 'email', 'type'], clockTolerance: 5,
    });
    if (payload.type !== 'app' || typeof payload.email !== 'string' || payload.email.toLowerCase() !== config.ownerEmail || typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 200) return null;
    return { ownerId: await ownerNamespace(config.issuer, payload.sub), subject: payload.sub };
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
