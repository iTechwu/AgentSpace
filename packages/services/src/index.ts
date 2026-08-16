// 巨型 barrel 收敛（3.7-7）：140 条 re-export 按域拆至 src/<domain>/index.ts，
// 根入口仅做域聚合。子路径导入推荐 `@dofe-agent/services/<domain>`。

export * from "./workflows/index.ts";
export * from "./skills/index.ts";
export * from "./employees/index.ts";
export * from "./workspace/index.ts";
export * from "./mcp-center/index.ts";
export * from "./models/index.ts";
export * from "./runtime/index.ts";
export * from "./integrations/index.ts";
export * from "./openmontage/index.ts";
export * from "./capabilities/index.ts";
export * from "./channels/index.ts";
export * from "./messaging/index.ts";
export * from "./tasks/index.ts";
export * from "./collaboration/index.ts";
export * from "./knowledge/index.ts";
export * from "./documents/index.ts";
export * from "./content/index.ts";
export * from "./finance/index.ts";
export * from "./operations/index.ts";
