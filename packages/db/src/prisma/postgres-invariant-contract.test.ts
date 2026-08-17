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
     ALTER TABLE real_table ADD CONSTRAINT real_check CHECK (id > 0);
     CREATE TYPE real_state AS ENUM ('ready', 'failed');
     CREATE VIEW real_view AS SELECT id FROM real_table;`,
  ]);
  assert.deepEqual(contract, {
    indexes: ["idx_online", "idx_real"],
    functions: ["real_function"],
    triggers: ["real_trigger"],
    checkConstraints: ["real_check"],
    indexPredicates: {},
    checkDefinitions: { real_check: "id > 0" },
    enumLabels: { real_state: ["ready", "failed"] },
    views: { real_view: "select id from real_table" },
    functionBodies: { real_function: "begin return new; end;" },
  });
});

test("invariant comparison reports missing custom objects", () => {
  const drift = comparePostgresInvariantContract(
    {
      indexes: ["idx_real"],
      functions: ["real_function"],
      triggers: ["real_trigger"],
      checkConstraints: ["real_check"],
      indexPredicates: {},
      checkDefinitions: {},
      enumLabels: {},
      views: {},
      functionBodies: {},
    },
    {
      indexes: [],
      functions: ["real_function"],
      triggers: [],
      checkConstraints: [],
      indexPredicates: {},
      checkDefinitions: {},
      enumLabels: {},
      views: {},
      functionBodies: {},
    },
  );
  assert.deepEqual(drift, [
    "missing index: idx_real",
    "missing trigger: real_trigger",
    "missing check constraint: real_check",
  ]);
});

test("invariant comparison detects definition-level drift", () => {
  const drift = comparePostgresInvariantContract(
    {
      indexes: [],
      functions: [],
      triggers: [],
      checkConstraints: [],
      indexPredicates: { idx_partial: "status = 'ready'" },
      checkDefinitions: { state_check: "state = 'ready'" },
      enumLabels: { state: ["ready", "failed"] },
      views: { active_view: "select id from item where active" },
      functionBodies: { guard: "begin return new; end;" },
    },
    {
      indexes: [],
      functions: [],
      triggers: [],
      checkConstraints: [],
      indexPredicates: { idx_partial: "status = 'blocked'" },
      checkDefinitions: { state_check: "state = 'failed'" },
      enumLabels: { state: ["ready", "paused"] },
      views: { active_view: "select id from item" },
      functionBodies: { guard: "begin return old; end;" },
    },
  );
  assert.deepEqual(drift, [
    "drifted index predicate: idx_partial",
    "drifted check definition: state_check",
    "drifted enum labels: state",
    "drifted view definition: active_view",
    "drifted function body: guard",
  ]);
});
