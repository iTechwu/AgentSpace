import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import {
  getDatabase,
  getDatabaseCacheStateForTests,
  resetDatabaseForTests,
  resetConcurrentIndexBuildForTests,
  setConcurrentIndexBuilderForTests,
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

/**
 * Standards #4：triggerConcurrentIndexBuild 失败须清 memo，使同进程下次 getDatabase 重入重试，
 * 而非只能在下次冷启动重试。成功路径才持久 memo（保留每进程一次去重）。
 */
test("triggerConcurrentIndexBuild 失败清 memo 重试，成功后持久 memo（Standards #4）", async () => {
  cleanCache();
  let invocations = 0;
  // builder：第 1 次抛错，第 2 次起成功。
  const builder = async () => {
    invocations += 1;
    if (invocations === 1) throw new Error("simulated concurrent index build failure");
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

  triggerConcurrentIndexBuildForTests("postgres://test-idx-url", builder);
  await flush();
  assert.equal(invocations, 1, "首次触发调用 builder");
  assert.equal(
    getDatabaseCacheStateForTests().concurrentIndexEnsuredForUrl,
    null,
    "失败后 memo 须清除，使下次可重试",
  );

  // 再次触发：memo 已清 → 重新调用 builder（成功）→ memo 持久化。
  triggerConcurrentIndexBuildForTests("postgres://test-idx-url", builder);
  await flush();
  assert.equal(invocations, 2, "失败清 memo 后下次触发重新调用 builder");
  assert.equal(
    getDatabaseCacheStateForTests().concurrentIndexEnsuredForUrl,
    "postgres://test-idx-url",
    "成功后 memo 持久化",
  );

  // 第三次触发：memo 已持久 → 不再调用 builder（去重）。
  triggerConcurrentIndexBuildForTests("postgres://test-idx-url", builder);
  await flush();
  assert.equal(invocations, 2, "成功后 memo 持久，不再重复触发");

  cleanCache();
});

/**
 * Standards #4 真实路径：上一个是直接调用 triggerConcurrentIndexBuildForTests 验证 memo 清除本身；
 * 此用例走真实 getDatabase()。关键回归点——schema 一旦校验成功，二次 getDatabase 走快路径在
 * database.ts:695 return，旧实现不经过 :715 的 triggerConcurrentIndexBuild，导致后台构建失败清掉的
 * memo 在同进程内永远不被重新触发，只能等下次冷启动。快路径必须也重入 trigger。
 */
test("getDatabase 快路径在后台构建失败后重新触发（Standards #4 真实路径）", async () => {
  resetDatabaseForTests();
  resetConcurrentIndexBuildForTests();
  setSchemaLockTimeoutMsForTests(null);
  let invocations = 0;
  // 仅注入 builder（不触发），使 getDatabase() 成为唯一触发源。
  const builder = async () => {
    invocations += 1;
    if (invocations === 1) throw new Error("simulated concurrent index build failure");
  };
  setConcurrentIndexBuilderForTests(builder);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

  try {
    // 第 1 次 getDatabase：慢路径，schema 校验后触发后台构建，builder 第 1 次抛错 → memo 被清。
    getDatabase();
    await flush();
    assert.equal(invocations, 1, "首次 getDatabase（慢路径）触发 builder 并失败");
    assert.equal(
      getDatabaseCacheStateForTests().concurrentIndexEnsuredForUrl,
      null,
      "失败后 memo 已清，等待重试",
    );

    // 第 2 次 getDatabase：schema 已校验 → 快路径。快路径必须重入 triggerConcurrentIndexBuild，
    // 否则清空的 memo 永远不会被重新触发（旧 bug）。
    getDatabase();
    await flush();
    assert.equal(invocations, 2, "快路径须在 memo 清空后重新触发后台构建");
    assert.equal(
      getDatabaseCacheStateForTests().concurrentIndexEnsuredForUrl,
      getDatabaseCacheStateForTests().databaseUrl,
      "重新构建成功后 memo 持久化",
    );

    // 第 3 次 getDatabase：memo 已持久 → 快路径不再触发（去重）。
    getDatabase();
    await flush();
    assert.equal(invocations, 2, "memo 持久后快路径不再重复触发");
  } finally {
    cleanCache();
  }
});
