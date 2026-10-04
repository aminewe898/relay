// Pure deterministic classifier. No raw provider text is returned or persisted.
const allowedClasses = new Set([
  'transient_external', 'malformed_output', 'invalid_input', 'configuration',
  'permanent_external', 'stale_lease', 'provider_unknown_result',
]);
const transportCodes = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ETIMEOUT', 'ECONNRESET', 'ECONNREFUSED',
  'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN',
  'EPIPE', 'ERR_SOCKET_CLOSED', 'ERR_SOCKET_CONNECTION_TIMEOUT', 'ERR_NETWORK',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'ECONNABORTED',
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const httpNumber = value => {
  const n = typeof value === 'string' && /^[1-5][0-9]{2}$/.test(value) ? Number(value) : value;
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : null;
};
const telegramAuthentication = new Set([
  'Unauthorized', 'Forbidden', 'Forbidden: bot was blocked by the user',
  'Authorization failed - please check your credentials',
]);
const telegramPermanent = new Set([
  'Bad Request: wrong file identifier/HTTP URL specified',
  'Bad Request: file_id not found', 'Bad Request: invalid file_id',
  'Bad Request: file_id is empty', 'Bad Request: file_id not specified',
  'Bad Request: file identifier is not specified',
  'Bad Request: invalid file identifier', 'Bad Request: file is too big',
  'Bad Request: wrong file type', 'Bad Request: unsupported file type',
  'Bad Request: wrong remote file identifier specified: Wrong character in the string',
]);

export function classifyStageFailure(input, {telegramLegacy = false} = {}) {
  // Only a well-formed internal failure object can override external evidence.
  const f = input?.failure;
  if (object(f) && allowedClasses.has(f.classification) &&
      Object.keys(f).every(k => ['classification', 'delaySeconds'].includes(k)) &&
      (f.delaySeconds === undefined || (Number.isInteger(f.delaySeconds) && f.delaySeconds >= 1 && f.delaySeconds <= 3600))) {
    return f.classification;
  }
  const error = object(input?.error) ? input.error : input;
  // Explicit allowlisted paths only: no request/headers/auth traversal or arbitrary recursion.
  const roots = [error, error?.cause, error?.context, input, input?.cause];
  const containers = roots.flatMap(r => object(r)
    ? [r, r.response, r.body, r.data, r.error, r.response?.body, r.response?.data, r.cause?.response, r.cause?.response?.body]
    : []).filter(object);
  // HTTP fields have precedence over provider codes and transport codes.
  let status = null;
  for (const key of ['statusCode', 'httpCode', 'status', 'error_code', 'code']) {
    for (const c of containers) {
      const candidate = httpNumber(c[key]);
      if (candidate !== null) { status = candidate; break; }
    }
    if (status !== null) break;
  }
  if (status === 401 || status === 403) return 'configuration';
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return 'transient_external';
  if (status >= 400 && status <= 499) return 'permanent_external';
  for (const c of containers) {
    if (typeof c.code === 'string' && transportCodes.has(c.code.toUpperCase())) return 'transient_external';
    if (['TimeoutError', 'RequestTimeoutError'].includes(c.name)) return 'transient_external';
  }
  const hasStructuredEvidence = containers.some(c =>
    ['statusCode', 'httpCode', 'status', 'error_code', 'code'].some(k =>
      Object.hasOwn(c, k) && c[k] !== null && c[k] !== undefined && c[k] !== ''));
  // Telegram v1.2 may strip NodeApiError to a description string. This fallback is
  // restricted to that branch and exact full signatures; never a broad substring search.
  if (!hasStructuredEvidence && telegramLegacy && typeof input?.error === 'string' && input.error.length <= 512) {
    const message = input.error.trim();
    if (telegramAuthentication.has(message)) return 'configuration';
    if (/^Too Many Requests: retry after [1-9][0-9]{0,5}$/.test(message)) return 'transient_external';
    if (telegramPermanent.has(message)) return 'permanent_external';
  }
  return 'provider_unknown_result';
}
