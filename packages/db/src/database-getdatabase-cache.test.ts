import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import {
  getDatabase,
  getDatabaseCacheStateForTests,
  resetDatabaseForTests,
  resetConcurrentIndexBuildForTests,
  setSchemaLockTimeoutMsForTests,
  triggerConcurrentIndexBuildForTests,
} from "./database.ts";
import { POSTGRES_SCHEMA_ADVISORY_LOCK_IDS } from "./postgres-schema.ts";
import { resolvePostgresDatabaseUrl } from "./postgres-config.ts";

/**
 * 这些测试针对 #4：getDatabase 在 ensureRuntimeSchema 抛错后不得缓存「未校验 schema」的连接。
 * 全部走真实 PG（agent_space_test），通过外部 pg 会话持有 [115,116] advisory lock 模拟
 * 「迁移锁被其他进程占用」的瞬时失败。
 */
function cleanCache(): void {
  resetDatabaseForTests();
  resetConcurrentIndexBuildForTests();
  // 注入 no-op builder，避免 getDatabase 触发的后台在线索引构建在这些单元测试里做真实 PG 工作。
  triggerConcurrentIndexBuildForTests("__noop__", async () => {});
  setSchemaLockTimeoutMsForTests(null);
}

async function holdSchemaLocks(): Promise<Client> {
  const client = new Client({ connectionString: resolvePostgresDatabaseUrl() });
  await client.connect();
  for (const lockId of POSTGRES_SCHEMA_ADVISORY_LOCK_IDS) {
    await client.query("SELECT pg_advisory_lock($1)", [lockId]);
  }
  return client;
}

async function releaseSchemaLocks(client: Client): Promise<void> {
  for (const lockId of POSTGRES_SCHEMA_ADVISORY_LOCK_IDS) {
    await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
  }
  await client.end();
}

test("getDatabase 缓存已校验 schema 的连接，二次调用走快路径返回同一句柄", () => {
  cleanCache();
  try {
    const first = getDatabase();
    const stateAfter = getDatabaseCacheStateForTests();
    assert.equal(stateAfter.hasDatabase, true);
    assert.equal(stateAfter.schemaEnsuredForUrl, stateAfter.databaseUrl);

    const second = getDatabase();
    assert.equal(second, first, "快路径应返回同一连接句柄");
    assert.equal(getDatabaseCacheStateForTests().schemaEnsuredForUrl, stateAfter.databaseUrl);
  } finally {
    cleanCache();
  }
});

test("迁移锁被占用时 getDatabase 抛错，且不缓存未校验连接；锁释放后重试真正重新校验 schema", async () => {
  cleanCache();
  setSchemaLockTimeoutMsForTests(400);
  const holder = await holdSchemaLocks();
  try {
    // 迁移锁被另一会话持有时，getDatabase 必须抛错，而非返回 schema 从未校验的连接。
    assert.throws(() => getDatabase(), /schema migration lock is busy/);
    const stateAfterFailure = getDatabaseCacheStateForTests();
    assert.equal(stateAfterFailure.schemaEnsuredForUrl, null, "失败后 schema 不得被标记为已校验");
    // 候选连接/worker 被保留，使瞬时失败可在下次调用复用而非 respawn worker。
    assert.equal(stateAfterFailure.hasDatabase, true, "瞬时失败应保留候选连接以便重试");
  } finally {
    await releaseSchemaLocks(holder);
  }

  // 锁释放后，重试必须真正重新执行 schema 校验（旧 bug：快路径直接返回未校验候选）。
  getDatabase();
  const stateAfterRetry = getDatabaseCacheStateForTests();
  assert.equal(stateAfterRetry.schemaEnsuredForUrl, stateAfterRetry.databaseUrl, "重试必须完成 schema 校验");

  cleanCache();
});
