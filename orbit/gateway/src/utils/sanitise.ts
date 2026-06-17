/*
 * Safe request sanitiser
 * ───────────────────────
 * Before storing any request for replay, we:
 *   1. Strip auth headers entirely (Authorization, Cookie, X-Api-Key)
 *   2. Redact sensitive body fields (password, token, card, etc.)
 *
 * WHY this matters in interviews:
 * Real companies cannot store production requests verbatim.
 * JWTs contain PII. Payment requests contain card numbers.
 * Showing you've thought about this signals security maturity.
 *
 * The sensitive field list comes from the service's policy in Postgres
 * so teams can extend it without changing code.
 */

const ALWAYS_STRIP_HEADERS = new Set([
    'authorization',
    'cookie',
    'x-api-key',
    'x-forwarded-for', // can contain real IPs
  ]);
  
  export function sanitiseHeaders(
    headers: Record<string, string | string[] | undefined>
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (ALWAYS_STRIP_HEADERS.has(key.toLowerCase())) continue;
      if (value !== undefined) {
        result[key] = Array.isArray(value) ? value.join(', ') : value;
      }
    }
    return result;
  }
  
  export function redactBody(
    body: unknown,
    sensitiveFields: string[]
  ): Record<string, unknown> | null {
    if (!body || typeof body !== 'object') return null;
  
    const sensitiveSet = new Set(
      sensitiveFields.map(f => f.toLowerCase())
    );
  
    function redactObject(obj: unknown): unknown {
      if (Array.isArray(obj)) return obj.map(redactObject);
      if (obj !== null && typeof obj === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
          result[key] = sensitiveSet.has(key.toLowerCase())
            ? '***'
            : redactObject(value);
        }
        return result;
      }
      return obj;
    }
  
    return redactObject(body) as Record<string, unknown>;
  }