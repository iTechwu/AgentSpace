// Phase 2 parity test harness — the safety net for migrating sync repos to
// async Prisma repos. Each migrated domain ships a parity test that runs the
// legacy `*Sync` function and the new `*Async` function against the SAME fixture
// and asserts the returned `*Record` DTOs are deep-equal.
//
// This is where the Date/Json/nullable fidelity rules (runtime-mappers.ts) are
// enforced: if an async repo forgets `toIsoString`, the Prisma `Date` diverges
// from the sync ISO string and `deepEqual` fails here.
//
// Canonical shape of a parity test file (see audit-log-prisma-parity.test.ts):
//   1. seed fixed rows via direct SQL (fixed ids / timestamps) into agent_space_test
//   2. parityTest("read ...", { sync: () => readXxxSync(...), async: () => readXxxAsync(...) })
//   3. for write parity where ids/timestamps legitimately differ, strip those keys
//      and compare inline with assert.deepEqual (do not use this helper for that)
//   4. cleanup deletes the seeded rows

import assert from "node:assert/strict";
import test from "node:test";

export interface ParityOptions<T> {
  /** Run once before both sync and async produce results (seed the fixture). */
  seed?: () => unknown | Promise<unknown>;
  /** Produce the legacy sync result. */
  sync: () => T | Promise<T>;
  /** Produce the async Prisma result. */
  async: () => Promise<T>;
  /** Run once after the comparison regardless of outcome (teardown). */
  cleanup?: () => unknown | Promise<unknown>;
}

/**
 * Register a parity test: same fixture → `sync()` and `async()` must return
 * deep-equal DTOs. Use for READ/LIST paths where both sides observe the same
 * seeded state without mutating it. Sequential (sync then async) to keep
 * transaction-visibility reasoning simple.
 */
export function parityTest<T>(name: string, options: ParityOptions<T>): void {
  test(`[parity] ${name}`, async () => {
    if (options.seed) await options.seed();
    try {
      const syncResult = await options.sync();
      const asyncResult = await options.async();
      assert.deepEqual(
        asyncResult,
        syncResult,
        `async Prisma repo diverged from sync repo for "${name}" — ` +
          "likely a missing Date→ISO / Json→string / null→undefined mapping (see runtime-mappers.ts).",
      );
    } finally {
      if (options.cleanup) await options.cleanup();
    }
  });
}

/**
 * Bare equality assertion for inline write-parity checks where ids / timestamps
 * legitimately differ between the sync and async writes. Strip those keys from
 * both sides, then call this.
 */
export function assertParityEqual<T>(
  syncResult: T,
  asyncResult: T,
  message = "async Prisma repo diverged from sync repo",
): void {
  assert.deepEqual(asyncResult, syncResult, message);
}
