const REDACTED = "[redacted]";
const TRUNCATED = "[truncated]";
const SENSITIVE_KEY = /(?:authorization|cookie|credential|pass(?:word)?|secret|token|api[_-]?key|private[_-]?key)/i;
const INLINE_SECRET = /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]+|(?:api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;]+)/gi;

export interface WorkflowDiagnosticRedactionOptions {
  maxArrayLength?: number;
  maxDepth?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
}

/** Produces a bounded, non-mutating diagnostic value safe for logs and events. */
export function redactWorkflowDiagnostic(
  input: unknown,
  secrets: readonly string[] = [],
  options: WorkflowDiagnosticRedactionOptions = {},
): unknown {
  const limits = {
    maxArrayLength: options.maxArrayLength ?? 20,
    maxDepth: options.maxDepth ?? 6,
    maxObjectKeys: options.maxObjectKeys ?? 50,
    maxStringLength: options.maxStringLength ?? 1_000,
  };
  const knownSecrets = secrets.filter((secret) => secret.length > 0).sort((left, right) => right.length - left.length);
  const visited = new WeakSet<object>();

  function visit(value: unknown, depth: number, sensitive = false): unknown {
    if (sensitive) return REDACTED;
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "undefined") return undefined;
    if (typeof value === "symbol" || typeof value === "function") return "[unsupported]";
    if (typeof value === "string") return redactString(value, knownSecrets, limits.maxStringLength);
    if (depth >= limits.maxDepth) return TRUNCATED;
    if (visited.has(value)) return "[circular]";
    visited.add(value);

    if (Array.isArray(value)) {
      const output = value.slice(0, limits.maxArrayLength).map((entry) => visit(entry, depth + 1));
      if (value.length > limits.maxArrayLength) output.push(TRUNCATED);
      return output;
    }

    if (value instanceof Date) return value.toISOString();
    const entries = Object.entries(value).slice(0, limits.maxObjectKeys);
    const output: Record<string, unknown> = {};
    for (const [key, child] of entries) {
      output[key] = visit(child, depth + 1, SENSITIVE_KEY.test(key));
    }
    if (Object.keys(value).length > limits.maxObjectKeys) output.__truncated__ = true;
    return output;
  }

  return visit(input, 0);
}

function redactString(value: string, secrets: readonly string[], maxLength: number): string {
  let result = value;
  for (const secret of secrets) result = result.split(secret).join(REDACTED);
  result = result.replace(INLINE_SECRET, REDACTED);
  return result.length > maxLength ? `${result.slice(0, maxLength)}${TRUNCATED}` : result;
}

