import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPrismaCutoverFlagsValid,
  PRISMA_CUTOVER_FLAG_REGISTRY,
} from "./cutover-flags.ts";

test("Prisma cutover registry accepts a registered read and shadow pair", () => {
  assert.doesNotThrow(() => assertPrismaCutoverFlagsValid({
    AGENT_SKILLS_PRISMA_READ_ENABLED: "1",
    AGENT_SKILLS_PRISMA_SHADOW_READ_ENABLED: "1",
  }));
  assert.ok(PRISMA_CUTOVER_FLAG_REGISTRY.length >= 20);
});

test("Prisma cutover registry rejects unknown and malformed flags", () => {
  assert.throws(
    () => assertPrismaCutoverFlagsValid({ AGENT_SKILL_PRISMA_READ_ENABLED: "1" }),
    /Unknown Prisma cutover flag/,
  );
  assert.throws(
    () => assertPrismaCutoverFlagsValid({ AGENT_SKILLS_PRISMA_READ_ENABLED: "enabled" }),
    /must be "0" or "1"/,
  );
});

test("Prisma shadow cutover requires its primary read flag", () => {
  assert.throws(
    () => assertPrismaCutoverFlagsValid({ AGENT_SKILLS_PRISMA_SHADOW_READ_ENABLED: "1" }),
    /requires AGENT_SKILLS_PRISMA_READ_ENABLED/,
  );
});

test("Prisma write registry rejects writes for read-only domains", () => {
  assert.throws(
    () => assertPrismaCutoverFlagsValid({ AGENT_SKILLS_PRISMA_WRITE_ENABLED: "1" }),
    /not registered for agent-skills/,
  );
  assert.doesNotThrow(() => assertPrismaCutoverFlagsValid({ SKILL_DRAFTS_PRISMA_WRITE_ENABLED: "1" }));
});
