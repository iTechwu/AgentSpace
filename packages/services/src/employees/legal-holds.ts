import { exportEmployeeDataLegalHoldProofSync, type EmployeeDataLegalHoldProof } from "@dofe-agent/db";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";

/**
 * Exports a tamper-evident legal-hold proof for a workspace / employee
 * (P1-6 导出能力). Records an audit event binding the proofDigest so every
 * export is attributable.
 */
export function exportLegalHoldProofSync(input: {
  workspaceId: string;
  employeeId?: string;
  actorUserId?: string;
  actorDisplayName?: string;
}): EmployeeDataLegalHoldProof {
  const proof = exportEmployeeDataLegalHoldProofSync({
    workspaceId: input.workspaceId,
    employeeId: input.employeeId,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Legal hold proof exported",
    note: `Legal hold proof (${proof.holds.length} holds) was exported${input.actorDisplayName ? ` by ${input.actorDisplayName}` : ""}.`,
    code: "employee.legal_hold_proof_exported",
    data: {
      resourceType: "employee_data_legal_hold",
      employeeId: input.employeeId,
      proofDigest: proof.proofDigest,
      actorUserId: input.actorUserId,
    },
  });
  return proof;
}
