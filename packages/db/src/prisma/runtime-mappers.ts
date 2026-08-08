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

/**
 * Prisma `Date` (or a legacy ISO string passthrough) → ISO string.
 * Returns `null` for null/undefined so callers can map nullable timestamps
 * (`createdAt: toIsoString(row.created_at) ?? undefined`).
 */
export function toIsoString(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : value.toISOString();
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
