import { getDatabase, readMetadataValue } from "@dofe-agent/db";

// Readiness probe：区分「进程存活」与「数据库不可用」。仅做一次轻量 SELECT 1
// 与 schema 版本读取，不调用慢外部供应商（模型、飞书、TOS 走独立的
// dependency health 指标，见 docs/0821/opz P1-06）。
//
// 说明：当前 DB 访问为同步门面（worker thread + Atomics.wait），readiness 走
// 同一路径；DB 连接超时/迁移竞态会短暂阻塞事件循环，属于 P1-02「DB 异步切流」
// 既有限制，不在此路由内引入独立超时（避免与迁移守卫语义分叉）。
export function GET(): Response {
  try {
    const db = getDatabase();
    const row = db.prepare("SELECT 1 AS present").get() as { present?: number } | undefined;
    if (row?.present !== 1) {
      return Response.json(
        {
          ok: false,
          service: "dofe-agent-web",
          ready: false,
          checks: { database: "unreachable" },
        },
        { status: 503 },
      );
    }
    const schemaVersion = readMetadataValue(db, "schema_version");
    return Response.json({
      ok: true,
      service: "dofe-agent-web",
      ready: true,
      checks: {
        database: "ok",
        schemaVersion: schemaVersion ?? "unknown",
      },
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        service: "dofe-agent-web",
        ready: false,
        checks: {
          database: (error as Error)?.message ?? String(error),
        },
      },
      { status: 503 },
    );
  }
}
