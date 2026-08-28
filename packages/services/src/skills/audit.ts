import { recordAuditLogSync } from "@dofe-agent/db";

/**
 * Skill lifecycle audit (06-实施计划 §9.3): immutable `audit_log` rows for the
 * security-relevant decisions in the install/upgrade chain — approval
 * decisions, plan creation, operation completion/failure, promotion and
 * rollback. `data` carries digests, ids and counts only — never file contents,
 * secrets, or raw tool arguments (脱敏摘要).
 */
export function recordSkillLifecycleAuditSync(input: {
  workspaceId: string;
  code: string;
  title: string;
  note: string;
  data?: Record<string, string | number | boolean | null>;
}): void {
  recordAuditLogSync({
    workspaceId: input.workspaceId,
    title: input.title,
    note: input.note,
    code: input.code,
    source: "skill_lifecycle",
    data: input.data,
  });
}
