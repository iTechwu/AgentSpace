#!/usr/bin/env node
// 非 HTTP 服务（worker / daemon / runtime-maintenance）的 readiness 探针。
//
// 这些进程不暴露 HTTP 端点，Docker healthcheck 用本脚本做一次轻量 DB 往返
// （SELECT 1 + schema 版本读取）作为「依赖就绪」信号：退出码 0 = ready，非 0 = not ready。
// 与 Web 的 /api/health/ready 走同一 getDatabase() 门面，语义一致。
//
// 说明：每个探针是独立进程，getDatabase() 会各自拉起 worker thread 并复用
// schema 校验 memo；DB 不可达时由迁移守卫/连接超时抛错 → 非 0 退出。
// 该同步路径的事件循环阻塞属 P1-02「DB 异步切流」既有限制（见 docs/0821/opz P1-06）。
// The production image keeps workspace dependencies scoped under each package,
// so this probe must not rely on a root-level pnpm workspace symlink.
import { getDatabase, readMetadataValue } from "../../packages/db/src/index.ts";

try {
  const db = getDatabase();
  const row = db.prepare("SELECT 1 AS present").get();
  if (row?.present !== 1) {
    console.error("[healthcheck] database unreachable (no SELECT 1 row)");
    process.exit(1);
  }
  const schemaVersion = readMetadataValue(db, "schema_version");
  console.log("[healthcheck] ok; schema_version=" + (schemaVersion ?? "unknown"));
  process.exit(0);
} catch (error) {
  console.error("[healthcheck] not ready: " + (error?.message ?? error));
  process.exit(1);
}
