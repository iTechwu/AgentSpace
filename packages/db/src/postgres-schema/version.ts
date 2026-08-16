// schema 版本与 advisory lock 常量（单一来源）。源自 postgres-schema.ts 源行 1-11。
export const POSTGRES_SCHEMA_VERSION = "120";
// 跨版本固定锁：不能使用 schema 版本作为锁键，否则滚动升级中的相邻版本会并发迁移。
// 取 116 兼容已经发布的 schema 116 实例；后续版本必须保持此值不变。
export const POSTGRES_SCHEMA_ADVISORY_LOCK_ID = 116;
// schema 115 已在运行时按版本号锁定；本次过渡同时取得两把锁，避免 115/116 并发迁移。
export const POSTGRES_SCHEMA_ADVISORY_LOCK_IDS = [115, POSTGRES_SCHEMA_ADVISORY_LOCK_ID] as const;
// 后台自愈（history 回填 + SET NOT NULL + 在线索引）专用锁。刻意与 schema 迁移锁 [115,116]
// 解耦：长耗时的后台建索引/回填不再阻塞第二实例冷启动时的迁移锁获取（反之亦然）。跨版本固定，
// 后续版本必须保持此值不变。后台任务用阻塞型 pg_advisory_lock 串行化跨实例（fire-and-forget，
// 非请求路径）。
export const POSTGRES_BACKGROUND_MAINTENANCE_LOCK_ID = 117;
