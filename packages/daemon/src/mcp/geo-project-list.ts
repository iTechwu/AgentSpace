import assert from "node:assert/strict";

const allowedProjectMetadata = new Set([
  "id",
  "name",
  "description",
  "status",
  "published_knowledge_base_id",
  "updated_at",
]);

export function assertSafeGeoProjectList(value: Record<string, unknown>, expectedTenantId: string): Record<string, unknown>[] {
  assert.equal(value.tenant_id, expectedTenantId, "Project listing must remain scoped to the task workspace.");
  assert.ok(Array.isArray(value.items), "Project listing must return an items array.");
  const items = value.items;
  assert.equal(value.count, items.length, "Project listing count must match the bounded item set.");

  for (const item of items) {
    assert.ok(item !== null && typeof item === "object" && !Array.isArray(item), "Project listing items must be objects.");
    const project = item as Record<string, unknown>;
    const unexpectedFields = Object.keys(project).filter((field) => !allowedProjectMetadata.has(field));
    assert.deepEqual(unexpectedFields, [], `Project listing leaked non-metadata fields: ${unexpectedFields.join(", ")}.`);
  }

  return items as Record<string, unknown>[];
}
