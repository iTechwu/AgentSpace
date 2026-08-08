// Phase 2 fidelity mappers — convert Prisma's native field shapes into the
// existing `*Record` DTO shapes so async Prisma repos return byte-identical
// records to the legacy sync repos (README §9 "DTO 稳定优先").
//
// The legacy postgres.js sync layer guaranteed three DTO shapes that Prisma
// breaks, and these helpers restore:
//   - timestamptz columns → ISO string   (Prisma returns `Date`)
//   - json / jsonb columns → string      (Prisma returns `JsonValue`)
//   - nullable columns → undefined       (Prisma returns `null`)
//
// Every async repo's `mapXxxFromPrisma` MUST route timestamp / json / nullable
// fields through these helpers, so the parity tests (Sync vs Async `deepEqual`)
// hold. Skipping a helper is the single most common source of parity drift.
//
// WHY READS CAST FIDELITY COLUMNS TO `::text`. @prisma/adapter-pg installs its
// own type parsers (dist/index.mjs `customParsers`): `normalize_timestamptz`
// does `time.replace(/[+-]\d{2}...$/, "+00:00")` — it relabels the offset to
// UTC WITHOUT shifting the wall-clock digits, so under a non-UTC PG session
// (e.g. +08) every timestamptz drifts by the session offset; and `toJson`
// returns raw text which Prisma then parses into a compact object. The legacy
// sync worker instead parses timestamptz via `new Date(rawText).toISOString()`
// (offset-correct) and jsonb via an identity parser (raw spaced text). To be
// byte-identical to that, async READS select `created_at::text` /
// `<json>::text` and feed the text through these helpers — which mirror the
// sync worker's logic exactly and are independent of the session timezone.
// Plain typed reads (`findUnique`) must NOT be trusted for timestamptz/json
// fidelity columns.

/**
 * timestamptz → ISO string, matching the legacy sync worker's
 * `normalizeTimestampValue` byte-for-byte. Accepts a Prisma `Date` OR the raw
 * PG text from a `::text` cast (`"2026-08-08 19:00:00+08"`); for text it runs
 * `new Date(value).toISOString()` so the offset is applied correctly, unlike
 * the adapter's offset-relabel. Unparseable text passes through unchanged.
 * Returns `null` for null/undefined so callers can map nullable timestamps.
 */
export function toIsoString(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/**
 * Prisma `JsonValue` (or a legacy string passthrough) → JSON string.
 * `null`/`undefined` → `"{}"` to match the legacy write default
 * (e.g. audit_log `data_json` is written as `JSON.stringify(data ?? {})`).
 */
export function toJsonString(value: unknown): string {
  if (value === null || value === undefined) return "{}";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Nullable DB column → optional DTO field. Maps `null`/`undefined` → `undefined`
 * (legacy DTOs model optional fields as `field?: string`, not `string | null`).
 */
export function toOptionalString(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}
