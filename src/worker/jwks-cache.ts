import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { normalizeAccessIssuer } from './config.ts';
const MAX_ISSUERS = 4;
/** Stores only reusable public-key resolvers, never JWTs, identities or request objects. */
export function createAccessResolverCache(factory: (issuer: string) => JWTVerifyGetKey, maxEntries = MAX_ISSUERS): (issuer: string) => JWTVerifyGetKey {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ISSUERS) throw new Error('invalid_cache_limit');
  const resolvers = new Map<string, JWTVerifyGetKey>();
  return (value: string): JWTVerifyGetKey => {
    const issuer = normalizeAccessIssuer(value);
    if (!issuer) throw new Error('invalid_access_issuer');
    const cached = resolvers.get(issuer);
    if (cached) { resolvers.delete(issuer); resolvers.set(issuer, cached); return cached; }
    const resolver = factory(issuer);
    resolvers.set(issuer, resolver);
    if (resolvers.size > maxEntries) resolvers.delete(resolvers.keys().next().value!);
    return resolver;
  };
}
// Reuse jose's bounded-age key cache and rotation cooldown within each Worker isolate.
export const accessResolver = createAccessResolverCache(issuer => createRemoteJWKSet(new URL(issuer + '/cdn-cgi/access/certs'), {
  timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000,
}));
