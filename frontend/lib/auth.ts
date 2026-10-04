import { createHash, timingSafeEqual } from 'node:crypto';
export type Mode = 'disconnected' | 'live';
type Environment = Record<string, string | undefined>;
export function mode(env: Environment = process.env): Mode {
  return env.SERVICE_DESK_MODE === 'live' ? 'live' : 'disconnected';
}
// Explicit desktop-only transport. Bind the server to loopback; never use behind a proxy.
export function localObserver(headers: Pick<Headers, 'get' | 'has'>, env: Environment = process.env) {
  if (env.SERVICE_DESK_TRANSPORT !== 'local-docker' || mode(env) !== 'live') return false;
  const host = headers.get('host');
  if (host !== '127.0.0.1:3100') return false;
  if (headers.has('forwarded')) return false;
  // Next.js adds its own loopback forwarding headers even without a reverse proxy.
  const forwardedHost = headers.get('x-forwarded-host');
  const forwardedFor = headers.get('x-forwarded-for');
  if (forwardedHost && forwardedHost !== host) return false;
  if (forwardedFor && !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(forwardedFor)) return false;
  if (headers.get('x-forwarded-proto') && headers.get('x-forwarded-proto') !== 'http') return false;
  const site = headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = headers.get('origin');
  return !origin || origin === 'http://127.0.0.1:3100';
}
export function canRead(headers: Pick<Headers, 'get' | 'has'>, env: Environment = process.env) {
  return localObserver(headers, env) || authorized(headers.get('authorization'), env);
}
export function authorized(header: string | null, env: Environment = process.env) {
  if (!env.SERVICE_DESK_AUTH_USER || !env.SERVICE_DESK_AUTH_PASSWORD || !header?.startsWith('Basic ')) return false;
  const credentials = `${env.SERVICE_DESK_AUTH_USER}:${env.SERVICE_DESK_AUTH_PASSWORD}`;
  const expected = createHash('sha256').update(credentials).digest();
  const actual = createHash('sha256').update(Buffer.from(header.slice(6), 'base64')).digest();
  return timingSafeEqual(expected, actual);
}
