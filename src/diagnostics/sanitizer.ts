import { isObject } from '../validation/workflow-validator.js';

const sensitive = /authorization|cookie|api[_-]?key|token|password|secret|credential|private[_-]?key/i;
const excluded = /^(?:request|response|body|headers?|binary|env|environment|environmentVariables|context|cause|errorResponse|customData|pinData|parameters|data)$/i;
const marker = '[REDACTED]';

/** Separate from workflow redaction: no credential references or payloads are emitted. */
export class DiagnosticSanitizer {
  readonly #secrets = new Set<string>();
  constructor(value: unknown, apiKey: string) {
    if (apiKey) this.#secrets.add(apiKey);
    const remember = (child: unknown): void => {
      if (typeof child === 'string' && child.length >= 4) this.#secrets.add(child);
      else if (Array.isArray(child)) child.forEach(remember);
      else if (isObject(child)) Object.values(child).forEach(remember);
    };
    const visit = (child: unknown): void => {
      if (Array.isArray(child)) child.forEach(visit);
      else if (isObject(child)) {
        for (const [key, entry] of Object.entries(child)) {
          // runData keys are user-defined node names, not request/secret field names.
          if (key === 'runData' && isObject(entry)) { Object.values(entry).forEach(visit); continue; }
          // data at the execution envelope is traversed; item data is collected below.
          if (sensitive.test(key) || (excluded.test(key) && key !== 'data')) remember(entry);
          else if (key === 'data' && !isObject(entry)) remember(entry);
          else visit(entry);
        }
        if (typeof child.name === 'string' && sensitive.test(child.name)) remember(child.value);
        // Item JSON can echo secrets into errors; never return it, even under innocent keys.
        if ('json' in child) remember(child.json);
      }
    };
    visit(value);
  }
  text(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim() || value.length > 2048) return undefined;
    let result = value;
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) result = result.split(secret).join(marker);
    result = result.replace(/\b(Bearer|Basic|Token)\s+[^\s,;"'<>]+/gi, `$1 ${marker}`);
    result = result.replace(/\b(?:set-cookie|cookie)\s*[=:]\s*[^\r\n]+/gi, `cookie=${marker}`);
    result = result.replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|client[_-]?secret|secret|credential|x-api-key)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/gi, `$1${marker}`);
    // URLs can hide secrets in paths, query strings, fragments or embedded credentials.
    result = result.replace(/https?:\/\/[^\s"'<>]+/gi, marker);
    result = result.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, marker);
    return result;
  }
  label(value: unknown): string | undefined {
    const text = this.text(value);
    return text && text.length <= 256 && !/[\r\n\x00-\x1f{}<>]/.test(text) ? text : undefined;
  }
  diagnosticText(value: unknown): string | undefined {
    const text = this.text(value);
    if (!text || /[\r\n{}<>]/.test(text) || /\b(?:request|response|headers?|body|payload|database|select|insert|update|environment)\b/i.test(text)) return undefined;
    // Exact technical phrases only: upstream descriptions can be arbitrary personal data.
    if (/^(?:Authorization failed(?: - please check your credentials)?|Bad request(?: - please check your parameters)?|Forbidden(?: - perhaps check your credentials)?|The resource you are requesting could not be found|Invalid expression|Expression is invalid|Cannot read properties of undefined|Referenced node doesn't exist|No data found for item-index|The service refused the connection(?: - perhaps it is offline)?|The connection timed out|Invalid credentials|Node execution failed)[.!]?$/i.test(text)) return text;
    if (/^(?:Bearer|Basic|Token) \[REDACTED\]$/i.test(text)) return text;
    if (/^(?:authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|client[_-]?secret|secret|credential|x-api-key)\s*[:=]\s*\[REDACTED\]$/i.test(text)) return text;
    return undefined;
  }
}
