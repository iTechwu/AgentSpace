// 技能导入（拆分后收敛为 barrel）：公共入口在 ./import/import-api，各域实现见同目录子模块。
// 公共导出面与拆分前一致，引用方（src/index.ts 与 import.test.ts）零改动。

export { checkSkillSourceUpdatesForWorkspaceSync, importWorkspaceSkillFromUrl, importWorkspaceSkillFromZipUpload, inspectWorkspaceSkillSourceUpdate } from "./import/import-api.ts";
export { deriveSkillCoordinate } from "./import/persist.ts";
export { SkillGitHubImportError } from "./import/types.ts";
export type { SkillSourceUpdateCheckSummary } from "./import/import-api.ts";
export type { SkillGitHubImportErrorCode, SkillImportConflict, SkillImportResult, SkillImportSourceType, SkillSourceUpdateInspection, SkillSourceUpdateStatus } from "./import/types.ts";
