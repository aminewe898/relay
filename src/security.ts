import { isObject } from './validation/workflow-validator.js';

// Heuristic redaction for workflow reads/previews. Raw execution payloads are never returned.
export function redact(value: unknown, apiKey: string): unknown {
  if (typeof value === 'string') {
    let result = apiKey ? value.split(apiKey).join('[REDACTED]') : value;
    result = result.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, '$1 [REDACTED]');
    result = result.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
    result = result.replace(/([?&](?:api[_-]?key|token|secret|password|access_token)=)[^&#\s]+/gi, '$1[REDACTED]');
    return result;
  }
  if (Array.isArray(value)) return value.map(v => redact(v, apiKey));
  if (!isObject(value)) return value;
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    if (/password|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|headers|binary|credentialData/i.test(key)) output[key] = '[REDACTED]';
    else if (key === 'credentials' && isObject(child)) {
      const refs: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [type, ref] of Object.entries(child)) if (isObject(ref)) refs[type] = redact({ id: ref.id, name: ref.name }, apiKey);
      output[key] = refs;
    } else if (key.toLowerCase() === 'value' && typeof value.name === 'string' && /password|secret|token|authorization|cookie|api[_-]?key/i.test(value.name)) output[key] = '[REDACTED]';
    else output[key] = redact(child, apiKey);
  }
  return output;
}
