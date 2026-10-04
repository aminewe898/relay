export interface Config {
  baseUrl: string;
  apiKey: string;
  dryRun: boolean;
  timeoutMs: number;
}

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('N8N_BASE_URL must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('N8N_BASE_URL must use HTTP(S), without credentials, query, or fragment.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/api/v1') ? path : `${path}/api/v1`;
  return url.toString().replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.N8N_BASE_URL?.trim()) throw new Error('Set N8N_BASE_URL.');
  if (!env.N8N_API_KEY?.trim()) throw new Error('Set N8N_API_KEY (including for API reads in dry-run mode).');
  if (/[\r\n]/.test(env.N8N_API_KEY)) throw new Error('N8N_API_KEY must not contain line breaks.');
  const dryRun = env.N8N_DRY_RUN ?? 'true';
  if (!['true', 'false'].includes(dryRun)) throw new Error('N8N_DRY_RUN must be true or false.');
  const timeoutMs = Number(env.N8N_REQUEST_TIMEOUT_MS ?? 15000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new Error('N8N_REQUEST_TIMEOUT_MS must be an integer between 1 and 120000.');
  }
  return { baseUrl: normalizeBaseUrl(env.N8N_BASE_URL), apiKey: env.N8N_API_KEY, dryRun: dryRun === 'true', timeoutMs };
}
