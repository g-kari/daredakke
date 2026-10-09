export type AuthConfig = { origin: string; issuer: string; audience: string; ownerEmail: string };
export function normalizeAccessIssuer(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const team = new URL(value);
    if (team.protocol !== 'https:' || !/^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(team.hostname) || team.port || team.username || team.password || team.pathname !== '/' || team.search || team.hash) return null;
    return team.origin;
  } catch { return null; }
}
export function readAuthConfig(env: Pick<Env, 'APP_ORIGIN' | 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUDIENCE' | 'OWNER_EMAIL'>): AuthConfig | null {
  try {
    const origin = new URL(env.APP_ORIGIN);
    const issuer = normalizeAccessIssuer(env.ACCESS_TEAM_DOMAIN);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port || origin.pathname !== '/' || origin.search || origin.hash) return null;
    if (!issuer) return null;
    const audience = env.ACCESS_AUDIENCE.trim(), ownerEmail = env.OWNER_EMAIL.trim().toLowerCase();
    if (!audience || audience.length > 300 || /\s/.test(audience) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) return null;
    return { origin: origin.origin, issuer, audience, ownerEmail };
  } catch { return null; }
}
