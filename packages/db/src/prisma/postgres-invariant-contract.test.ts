import assert from "node:assert/strict";
import test from "node:test";
import {
  comparePostgresInvariantContract,
  extractPostgresInvariantContract,
} from "./postgres-invariant-contract.ts";

test("invariant contract extracts named objects and ignores SQL comments", () => {
  const contract = extractPostgresInvariantContract([
    `-- CREATE INDEX fake_index ON fake_table(id)
     CREATE UNIQUE INDEX IF NOT EXISTS idx_real ON real_table(id);
     CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_online ON real_table(created_at);
     CREATE OR REPLACE FUNCTION real_function() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;
     CREATE TRIGGER real_trigger BEFORE INSERT ON real_table FOR EACH ROW EXECUTE FUNCTION real_function();
     ALTER TABLE real_table ADD CONSTRAINT real_check CHECK (id > 0);`,
  ]);
  assert.deepEqual(contract, {
    indexes: ["idx_online", "idx_real"],
    functions: ["real_function"],
    triggers: ["real_trigger"],
    checkConstraints: ["real_check"],
  });
});

test("invariant comparison reports missing custom objects", () => {
  const drift = comparePostgresInvariantContract(
    {
      indexes: ["idx_real"],
      functions: ["real_function"],
      triggers: ["real_trigger"],
      checkConstraints: ["real_check"],
    },
    { indexes: [], functions: ["real_function"], triggers: [], checkConstraints: [] },
  );
  assert.deepEqual(drift, [
    "missing index: idx_real",
    "missing trigger: real_trigger",
    "missing check constraint: real_check",
  ]);
});
