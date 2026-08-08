import {
  appendWorkflowRunEventSync,
  cancelQueuedTaskSync,
  deferWorkflowApprovalCandidateSync,
  getDatabase,
  listWorkflowNodeRunsSync,
  listWorkflowApprovalCandidatesSync,
  backfillWorkflowNodeRunApprovalDeadlineSync,
  lockWorkflowRunForUpdateSync,
  readWorkflowNodeRunSync,
  readQueuedTaskSync,
  readWorkflowNodeRunByApprovalIdSync,
  readWorkflowRunSync,
  readWorkflowVersionSync,
  enqueueWorkflowOutboxSync,
  recordAuditLogSync,
  transitionWorkflowNodeRunSync,
  transitionWorkflowRunSync,
  withTransaction,
  type WorkflowNodeRunRecord,
  type WorkflowRunRecord,
} from "@dofe-agent/db";
import type { WorkflowGraphDefinition } from "@dofe-agent/domain";
import { listApprovalsSync, reviewApprovalSync } from "../approvals/approvals.ts";
import {
  buildWorkflowNodeRuntimeContext,
  getWorkflowInputResolutionErrorCode,
  mergeWorkflowArtifactManifests,
} from "./inputs.ts";

export interface CompleteWorkflowNodeInput {
  workspaceId: string;
  nodeRunId: string;
  taskQueueId: string;
  output: Record<string, unknown>;
  artifactManifest?: unknown[];
  now?: string;
}

export function completeWorkflowNodeSync(input: CompleteWorkflowNodeInput): WorkflowRunRecord {
  const db = getDatabase();
  const now = input.now ?? new Date().toISOString();
  return withTransaction(db, () => {
    const candidate = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
    if (!candidate) throw new Error("workflow_node_run_not_found");
    const run = lockWorkflowRunForUpdateSync(candidate.runId, input.workspaceId);
    if (!run) throw new Error("workflow_run_not_found");
    const nodeRun = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
    if (!nodeRun) throw new Error("workflow_node_run_not_found");
    if (nodeRun.status === "succeeded" || nodeRun.status === "failed" || nodeRun.status === "cancelled") return run;
    if (nodeRun.taskQueueId !== input.taskQueueId) throw new Error("workflow_task_queue_mismatch");
    const taskWorkspace = db.prepare("SELECT workspace_id AS workspaceId FROM agent_task_queue WHERE id = ?")
      .get(input.taskQueueId) as { workspaceId?: string } | undefined;
    if (taskWorkspace?.workspaceId !== input.workspaceId) throw new Error("workflow_cross_workspace_reference");
    const updated = transitionWorkflowNodeRunSync({
      workspaceId: input.workspaceId,
      nodeRunId: nodeRun.id,
      from: ["queued", "running"],
      to: "succeeded",
      outputJson: JSON.stringify(input.output),
      artifactManifestJson: JSON.stringify(input.artifactManifest ?? []),
      finishedAt: now,
      now,
    });
    if (!updated) return readWorkflowRunSync(run.id, input.workspaceId)!;
    appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: run.id, nodeRunId: nodeRun.id, type: "node.succeeded", actorType: "daemon", dataJson: JSON.stringify({ taskQueueId: input.taskQueueId }), now });
    advanceDownstream({ workspaceId: input.workspaceId, run, completed: updated, now });
    return finalizeRunIfTerminal(input.workspaceId, run, now);
  });
}

export function failWorkflowNodeSync(input: {
  workspaceId: string;
  nodeRunId: string;
  taskQueueId: string;
  errorCode?: string;
  errorMessage?: string;
  now?: string;
}): WorkflowRunRecord {
  const db = getDatabase();
  const now = input.now ?? new Date().toISOString();
  return withTransaction(db, () => {
    const candidate = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
    if (!candidate) throw new Error("workflow_node_run_not_found");
    const run = lockWorkflowRunForUpdateSync(candidate.runId, input.workspaceId);
    if (!run) throw new Error("workflow_run_not_found");
    const nodeRun = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
    if (!nodeRun) throw new Error("workflow_node_run_not_found");
    if (["succeeded", "failed", "cancelled"].includes(nodeRun.status)) return run;
    if (nodeRun.taskQueueId !== input.taskQueueId) throw new Error("workflow_task_queue_mismatch");
    const updated = transitionWorkflowNodeRunSync({
      workspaceId: input.workspaceId,
      nodeRunId: nodeRun.id,
      from: ["queued", "running", "retry_wait"],
      to: "failed",
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      finishedAt: now,
      now,
    });
    if (updated) {
      appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: run.id, nodeRunId: nodeRun.id, type: "node.failed", actorType: "daemon", severity: "error", dataJson: JSON.stringify({ code: input.errorCode }), now });
      if (updated.attemptCount >= updated.maxAttempts) {
        advanceDownstream({ workspaceId: input.workspaceId, run, completed: updated, now });
      }
    }
    if (updated && updated.attemptCount < updated.maxAttempts) {
      return readWorkflowRunSync(run.id, input.workspaceId)!;
    }
    return finalizeRunIfTerminal(input.workspaceId, run, now);
  });
}

export function failStaleWorkflowNodeSync(input: {
  workspaceId: string;
  nodeRunId: string;
  actorId: string;
  now: string;
}): WorkflowNodeRunRecord | null {
  return withTransaction(getDatabase(), () => {
    const candidate = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
    if (!candidate) throw new Error("workflow_node_run_not_found");
    const run = lockWorkflowRunForUpdateSync(candidate.runId, input.workspaceId);
    if (!run) throw new Error("workflow_run_not_found");
    const nodeRun = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
    if (!nodeRun) throw new Error("workflow_node_run_not_found");
    if (nodeRun.status !== "queued") return null;
    const failed = transitionWorkflowNodeRunSync({
      workspaceId: input.workspaceId,
      nodeRunId: nodeRun.id,
      from: ["queued"],
      to: "failed",
      clearTaskQueueId: true,
      errorCode: "workflow_stale_queue_recovered",
      errorMessage: "queued task disappeared before completion",
      finishedAt: input.now,
      now: input.now,
    });
    if (!failed) return null;
    appendWorkflowRunEventSync({
      workspaceId: input.workspaceId,
      runId: run.id,
      nodeRunId: failed.id,
      type: "node.failed",
      actorType: "system",
      actorId: input.actorId,
      severity: "error",
      dataJson: JSON.stringify({ code: "workflow_stale_queue_recovered" }),
      now: input.now,
    });
    if (failed.attemptCount >= failed.maxAttempts) {
      advanceDownstream({ workspaceId: input.workspaceId, run, completed: failed, now: input.now });
      finalizeRunIfTerminal(input.workspaceId, run, input.now);
    }
    return failed;
  });
}

export function failWorkflowNodeBeforeDispatchSync(input: {
  workspaceId: string;
  nodeRunId: string;
  errorCode: "workflow_input_reference_missing" | "workflow_version_node_missing";
  now: string;
}): WorkflowNodeRunRecord {
  return withTransaction(getDatabase(), () => {
    const candidate = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
    if (!candidate) throw new Error("workflow_node_run_not_found");
    const run = lockWorkflowRunForUpdateSync(candidate.runId, input.workspaceId);
    if (!run) throw new Error("workflow_run_not_found");
    const nodeRun = readWorkflowNodeRunSync(input.nodeRunId, input.workspaceId);
    if (!nodeRun) throw new Error("workflow_node_run_not_found");
    const failed = transitionWorkflowNodeRunSync({
      workspaceId: input.workspaceId,
      nodeRunId: nodeRun.id,
      from: ["ready"],
      to: "failed",
      errorCode: input.errorCode,
      finishedAt: input.now,
      now: input.now,
    });
    if (!failed) return readWorkflowNodeRunSync(nodeRun.id, input.workspaceId)!;
    appendWorkflowRunEventSync({
      workspaceId: input.workspaceId,
      runId: run.id,
      nodeRunId: failed.id,
      type: "node.failed",
      actorType: "dispatcher",
      severity: "error",
      dataJson: JSON.stringify({ code: input.errorCode }),
      now: input.now,
    });
    advanceDownstream({ workspaceId: input.workspaceId, run, completed: failed, now: input.now });
    finalizeRunIfTerminal(input.workspaceId, run, input.now);
    return failed;
  });
}

export function completeWorkflowApprovalNodeSync(input: {
  workspaceId: string;
  approvalId: string;
  actorUserId: string;
  approved: boolean;
  now?: string;
  // 驳回时使用的错误码（默认 workflow_approval_rejected）；审批限时到期自动驳回时
  // 传 workflow_approval_deadline_exceeded，使运行失败原因可区分。
  errorCode?: string;
  actorType?: "human" | "system";
}): WorkflowRunRecord {
  const db = getDatabase();
  const now = input.now ?? new Date().toISOString();
  const rejectErrorCode = input.approved ? undefined : (input.errorCode ?? "workflow_approval_rejected");
  return withTransaction(db, () => {
    const candidate = readWorkflowNodeRunByApprovalIdSync(input.approvalId, input.workspaceId);
    if (!candidate) throw new Error("workflow_approval_not_linked");
    const run = lockWorkflowRunForUpdateSync(candidate.runId, input.workspaceId);
    if (!run) throw new Error("workflow_run_not_found");
    const nodeRun = readWorkflowNodeRunByApprovalIdSync(input.approvalId, input.workspaceId);
    if (!nodeRun) throw new Error("workflow_approval_not_linked");
    if (nodeRun.status !== "waiting_approval") return run;
    const updated = transitionWorkflowNodeRunSync({
      workspaceId: input.workspaceId,
      nodeRunId: nodeRun.id,
      from: ["waiting_approval"],
      to: input.approved ? "succeeded" : "failed",
      outputJson: input.approved ? JSON.stringify({ approved: true, actorUserId: input.actorUserId }) : undefined,
      errorCode: rejectErrorCode,
      finishedAt: now,
      now,
    });
    if (!updated) return readWorkflowRunSync(run.id, input.workspaceId)!;
    appendWorkflowRunEventSync({
      workspaceId: input.workspaceId,
      runId: run.id,
      nodeRunId: nodeRun.id,
      type: input.approved ? "approval.approved" : "approval.rejected",
      actorType: input.actorType ?? "human",
      actorId: input.actorUserId,
      severity: input.approved ? "info" : "error",
      dataJson: JSON.stringify({ approvalId: input.approvalId, ...(rejectErrorCode ? { code: rejectErrorCode } : {}) }),
      now,
    });
    if (!input.approved) {
      // 提交竞态守卫（与 cancelWorkflowRunSync 一致）：若任一兄弟节点任务正处于
      // preparing_commit/committed（EAD §7 提交拆分的中间态/不可逆点），不得终止 Run。
      // 否则 cancelQueuedTaskSync 对 committed 是 no-op（不可取消），却仍把节点标 cancelled、
      // Run 标 failed，造成「产物已提交、编排显示失败」的矛盾。此处抛出后事务整体回滚
      // （审批节点回到 waiting_approval），调用方在短暂提交窗口后重试：人工驳回经 API 返回 409，
      // 限时扫描经 expireWorkflowApprovalsSync 的 catch 记录 workflow_run_commit_in_progress 并 defer 重试。
      if (listWorkflowNodeRunsSync(input.workspaceId, run.id).some((node) => {
        if (node.id === updated.id || !node.taskQueueId) return false;
        const task = readQueuedTaskSync(node.taskQueueId);
        return task?.status === "preparing_commit" || task?.status === "committed";
      })) {
        throw new Error("workflow_run_commit_in_progress");
      }
      for (const candidate of listWorkflowNodeRunsSync(input.workspaceId, run.id)) {
        if (candidate.id === updated.id || ["succeeded", "failed", "skipped", "cancelled"].includes(candidate.status)) continue;
        if (candidate.taskQueueId && readQueuedTaskSync(candidate.taskQueueId)) {
          cancelQueuedTaskSync({ taskId: candidate.taskQueueId, errorText: rejectErrorCode! });
        }
        transitionWorkflowNodeRunSync({
          workspaceId: input.workspaceId,
          nodeRunId: candidate.id,
          from: [candidate.status],
          to: "cancelled",
          errorCode: rejectErrorCode,
          finishedAt: now,
          now,
        });
      }
      const failedRun = transitionWorkflowRunSync({
        workspaceId: input.workspaceId,
        runId: run.id,
        from: ["created", "queued", "running", "waiting_approval", "paused"],
        to: "failed",
        finishedAt: now,
        now,
      });
      if (!failedRun) throw new Error("workflow_run_control_conflict");
      appendWorkflowRunEventSync({
        workspaceId: input.workspaceId,
        runId: run.id,
        type: "run.failed",
        actorType: "coordinator",
        severity: "error",
        dataJson: JSON.stringify({ code: rejectErrorCode }),
        now,
      });
      return failedRun;
    }
    const hasOtherWaitingApproval = listWorkflowNodeRunsSync(input.workspaceId, run.id)
      .some((node) => node.id !== updated.id && node.status === "waiting_approval");
    if (!hasOtherWaitingApproval) {
      transitionWorkflowRunSync({ workspaceId: input.workspaceId, runId: run.id, from: ["waiting_approval"], to: "running", now });
    }
    advanceDownstream({ workspaceId: input.workspaceId, run, completed: updated, now });
    return finalizeRunIfTerminal(input.workspaceId, run, now);
  });
}

/**
 * 审批限时扫描：找出所有 `metadata.expiresAt` 已到期、且节点仍在等待审批的工作流审批，
 * 以 `workflow_approval_deadline_exceeded` 错误码自动驳回并终结运行。
 *
 * 扫描范围以 `workflow_run.status = 'waiting_approval'` 的工作区为界，避免全量遍历；
 * 由调度器周期性调用（见 scheduler.ts 的 tick）。可选 `workspaceId` 将扫描限定在单个
 * 工作区内——当调度器以工作区范围调用时，绝不能越界处理其他工作区的审批。
 *
 * 可观测性：单条审批处理失败不再被静默吞掉，而是记录为结构化失败（含 workspaceId/
 * runId/approvalId/errorCode）并写入审计日志，供告警与值班定位；失败不阻断其余审批
 * 的扫描，下一轮 tick 重试。非法调度时钟（now 不可解析）在扫描前直接拒绝——否则
 * `expiresAt > NaN` 恒为 false，会导致所有合法限时审批被批量误驳回。
 */
export interface WorkflowApprovalExpiryFailure {
  approvalId: string;
  workspaceId: string;
  runId?: string;
  errorCode: string;
}

const APPROVAL_SCAN_RETRY_DELAY_MS = 60_000;

export function expireWorkflowApprovalsSync(input: {
  now?: string;
  limit?: number;
  workspaceId?: string;
}): { expiredApprovalIds: string[]; failures: WorkflowApprovalExpiryFailure[] } {
  const db = getDatabase();
  const now = input.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  // 时钟校验：now 不可解析时必须拒绝扫描，避免 NaN 比较导致批量误驳回。
  if (!Number.isFinite(nowMs)) throw new Error("workflow_now_invalid");
  const expiredApprovalIds: string[] = [];
  const failures: WorkflowApprovalExpiryFailure[] = [];
  const retryAt = new Date(nowMs + APPROVAL_SCAN_RETRY_DELAY_MS).toISOString();
  // 数据库级有界扫描：直接在 workflow_node_run（approval_id 有索引）上以
  // status='waiting_approval' AND approval_id IS NOT NULL 过滤并施加 LIMIT，得到本轮候选
  // (workspaceId/runId/nodeId/approvalId)，而不是枚举全部 waiting_approval 工作区、再逐个
  // 加载整份审批历史 JSON（技术架构文档要求按 workspace/status 分片批量扫描）。limit 约束
  // 本轮候选总数；candidate.runId 即审批关联的权威运行，取代 best-effort 反查。
  const limit = typeof input.limit === "number" && input.limit > 0 ? Math.min(input.limit, 500) : 100;
  const candidates = listWorkflowApprovalCandidatesSync(
    input.workspaceId ? { workspaceId: input.workspaceId, now, limit } : { now, limit },
  );
  // 按工作区分组：每个工作区的审批 JSON 只加载一次，再按 approvalId 建索引，避免逐候选
  // 重复读取整份快照。逐候选评估其审批是否 pending + 限时 + 已到期。
  type ApprovalEntry = ReturnType<typeof listApprovalsSync>[number];
  const approvalsByWorkspace = new Map<string, Map<string, ApprovalEntry>>();
  for (const candidate of candidates) {
    let workspaceApprovals = approvalsByWorkspace.get(candidate.workspaceId);
    if (!workspaceApprovals) {
      workspaceApprovals = new Map<string, ApprovalEntry>();
      for (const approval of listApprovalsSync(candidate.workspaceId)) {
        workspaceApprovals.set(approval.id, approval);
      }
      approvalsByWorkspace.set(candidate.workspaceId, workspaceApprovals);
    }
    const approval = workspaceApprovals.get(candidate.approvalId);
    // 关联损坏：节点运行绑定了 approval_id，但工作区审批状态中找不到该审批记录（审批被删除/
    // 数据损坏/跨工作区错引）。原先与「他路径已终结」合并静默 continue，会让该节点永久悬挂且
    // 无任何告警。改为记稳定错误码并写审计，随 failures 上报给调度器告警出口（schedulerFailures），
    // 交由 on-call/reconciliation 介入——不自动驳回（无审批实体可终结）。
    if (!approval) {
      failures.push({ approvalId: candidate.approvalId, workspaceId: candidate.workspaceId, runId: candidate.runId, errorCode: "workflow_approval_association_broken" });
      recordApprovalExpiryFailureBestEffort({ workspaceId: candidate.workspaceId, runId: candidate.runId, approvalId: candidate.approvalId, errorCode: "workflow_approval_association_broken", now });
      deferWorkflowApprovalCandidateSync({ ...candidate, scanAfter: retryAt, now });
      continue;
    }
    // 审批已由其它路径（人工审批等）终结：限时扫描无需处理，跳过。节点运行的后续推进由该终结
    // 路径负责；若仍停留在 waiting_approval，由 recovery/reconciliation 扫描另行处理。
    if (approval.status !== "pending") {
      deferWorkflowApprovalCandidateSync({ ...candidate, scanAfter: retryAt, now });
      continue;
    }
    if (approval.metadata?.kind !== "workflow_node") {
      deferWorkflowApprovalCandidateSync({ ...candidate, scanAfter: retryAt, now });
      continue;
    }
    const expiresAtRaw = typeof approval.metadata?.expiresAt === "string" ? approval.metadata.expiresAt : undefined;
    if (!expiresAtRaw) {
      deferWorkflowApprovalCandidateSync({ ...candidate, scanAfter: retryAt, now });
      continue;
    }
    const expiresAtMs = Date.parse(expiresAtRaw);
    if (!Number.isFinite(expiresAtMs)) {
      // 非法截止时间：发布预检会校验新配置，但历史 JSON、迁移数据或人工修改仍可能留下
      // 无法解析的 expiresAt。原先静默 continue 会让这类审批永久悬挂且不出现在 failures
      // 或告警出口。改为记为稳定错误码并写入结构化审计、按失败上报——不自动驳回
      // （没有有效截止时间就没有终结依据），交由 on-call 经告警介入处理。
      failures.push({ approvalId: approval.id, workspaceId: candidate.workspaceId, runId: candidate.runId, errorCode: "workflow_approval_deadline_invalid" });
      recordApprovalExpiryFailureBestEffort({ workspaceId: candidate.workspaceId, runId: candidate.runId, approvalId: approval.id, errorCode: "workflow_approval_deadline_invalid", now });
      deferWorkflowApprovalCandidateSync({ ...candidate, scanAfter: retryAt, now });
      continue;
    }
    // 惰性回填：迁移前历史数据 approval_deadline 列为 NULL（候选查询的 NULL 安全分支将其纳入）。
    // 此处已确认 JSON expiresAt 有效，回填列使该行加入限时索引集，后续轮次按列精确命中、
    // 无需重复加载整份审批 JSON 评估。幂等（仅列仍为 NULL 时写入），不更新 updated_at。
    if (!candidate.approvalDeadline) {
      backfillWorkflowNodeRunApprovalDeadlineSync({ workspaceId: candidate.workspaceId, runId: candidate.runId, nodeId: candidate.nodeId, approvalDeadline: expiresAtRaw });
    }
    if (expiresAtMs > nowMs) {
      deferWorkflowApprovalCandidateSync({ ...candidate, scanAfter: expiresAtRaw, now });
      continue;
    }
    try {
      // 原子性约束：审批状态、节点状态与运行状态必须在同一事务内推进。若终结节点
      // 或运行失败，整个事务回滚——审批记录仍是 pending，下一轮 tick 会重试，避免
      // 出现「审批已驳回但运行永久卡在 waiting_approval」的悬挂态。
      withTransaction(db, () => {
        reviewApprovalSync(approval.id, "rejected", "workflow_approval_deadline_exceeded", candidate.workspaceId, { suppressConversationMessage: true });
        completeWorkflowApprovalNodeSync({
          workspaceId: candidate.workspaceId,
          approvalId: approval.id,
          actorUserId: "system",
          approved: false,
          errorCode: "workflow_approval_deadline_exceeded",
          actorType: "system",
          now,
        });
      });
      expiredApprovalIds.push(approval.id);
    } catch (error) {
      // 并发冲突或运行已被其它路径终结：整体回滚（审批仍 pending）。不再静默——
      // 记录结构化失败并写入审计日志，供告警/值班定位；继续扫描其余审批。
      const errorCode = error instanceof Error && /^workflow_[a-z0-9_]+$/.test(error.message)
        ? error.message
        : "workflow_approval_scan_failed";
      failures.push({ approvalId: approval.id, workspaceId: candidate.workspaceId, runId: candidate.runId, errorCode });
      recordApprovalExpiryFailureBestEffort({ workspaceId: candidate.workspaceId, runId: candidate.runId, approvalId: approval.id, errorCode, now });
      deferWorkflowApprovalCandidateSync({ ...candidate, scanAfter: retryAt, now });
    }
  }
  return { expiredApprovalIds, failures };
}

/** 尽力把审批扫描失败写入审计日志；审计写入失败不得阻断扫描其余审批。 */
function recordApprovalExpiryFailureBestEffort(input: {
  workspaceId: string;
  runId?: string;
  approvalId: string;
  errorCode: string;
  now: string;
}): void {
  try {
    recordAuditLogSync({
      workspaceId: input.workspaceId,
      title: "Workflow approval deadline scan failed",
      note: "approval_deadline_scan_failed",
      code: input.errorCode,
      source: "runtime_lifecycle",
      data: {
        approvalId: input.approvalId,
        ...(input.runId ? { runId: input.runId } : {}),
        reasonCode: input.errorCode,
        occurredAt: input.now,
      },
    });
  } catch {
    // 审计日志不可写时不应放大故障；结构化失败仍随返回值上报给调度器。
  }
}

function advanceDownstream(input: { workspaceId: string; run: WorkflowRunRecord; completed: WorkflowNodeRunRecord; now: string }): void {
  const version = readWorkflowVersionSync(input.run.versionId, input.workspaceId);
  if (!version) throw new Error("workflow_version_not_found");
  const graph = JSON.parse(version.graphJson) as WorkflowGraphDefinition;
  const allRuns = listWorkflowNodeRunsSync(input.workspaceId, input.run.id);
  const byId = new Map(allRuns.map((node) => [node.nodeId, node]));
  const sources = [input.completed.nodeId];
  while (sources.length > 0) {
    const sourceId = sources.shift();
    if (!sourceId) continue;
    for (const edge of graph.edges.filter((candidate) => candidate.source === sourceId)) {
      const target = byId.get(edge.target);
      if (!target || target.status !== "pending") continue;
      const predecessors = graph.edges
        .filter((candidate) => candidate.target === target.nodeId)
        .map((candidate) => byId.get(candidate.source))
        .filter((node): node is WorkflowNodeRunRecord => Boolean(node));
      const targetConfig = parseConfig(target.inputJson);
      const policy = targetConfig.policy === "allow_partial" ? "allow_partial" : "all_success";
      const decision = decideWorkflowDownstreamTransition({
        nodeType: target.nodeType,
        policy,
        predecessorStatuses: predecessors.map((node) => node.status),
      });
      if (decision === "wait") continue;

      if (decision === "ready") {
        let runtimeContext;
        try {
          runtimeContext = buildWorkflowNodeRuntimeContext({
            graph,
            nodeId: target.nodeId,
            runInput: parseRecord(input.run.inputJson),
            nodeRuns: [...byId.values()],
          });
        } catch (error) {
          const errorCode = getWorkflowInputResolutionErrorCode(error);
          if (!errorCode) throw error;
          const failed = transitionWorkflowNodeRunSync({
            workspaceId: input.workspaceId,
            nodeRunId: target.id,
            from: ["pending"],
            to: "failed",
            errorCode,
            finishedAt: input.now,
            now: input.now,
          });
          if (failed) {
            byId.set(failed.nodeId, failed);
            appendWorkflowRunEventSync({
              workspaceId: input.workspaceId,
              runId: input.run.id,
              nodeRunId: failed.id,
              type: "node.failed",
              actorType: "coordinator",
              severity: "error",
              dataJson: JSON.stringify({ code: errorCode }),
              now: input.now,
            });
            sources.push(failed.nodeId);
          }
          continue;
        }
        const ready = transitionWorkflowNodeRunSync({
          workspaceId: input.workspaceId,
          nodeRunId: target.id,
          from: ["pending"],
          to: "ready",
          availableAt: input.now,
          inputJson: JSON.stringify({ ...targetConfig, input: runtimeContext.resolvedInput }),
          now: input.now,
        });
        if (ready) {
          byId.set(ready.nodeId, ready);
          enqueueWorkflowOutboxSync({ workspaceId: input.workspaceId, aggregateType: "workflow_node_run", aggregateId: target.id, eventType: "workflow.node.ready", payloadJson: JSON.stringify({ nodeRunId: target.id }), now: input.now });
        }
        continue;
      }

      if (decision === "succeed_join") {
        const succeeded = predecessors.filter((node) => node.status === "succeeded");
        const outputs = Object.fromEntries(succeeded.map((node) => [node.nodeId, parseJson(node.outputJson)]));
        const artifacts = mergeWorkflowArtifactManifests(succeeded.map((node) => node.artifactManifestJson));
        const joined = transitionWorkflowNodeRunSync({ workspaceId: input.workspaceId, nodeRunId: target.id, from: ["pending"], to: "succeeded", outputJson: JSON.stringify({ outputs }), artifactManifestJson: JSON.stringify(artifacts), finishedAt: input.now, now: input.now });
        if (joined) {
          byId.set(joined.nodeId, joined);
          appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: input.run.id, nodeRunId: target.id, type: "join.succeeded", actorType: "coordinator", dataJson: JSON.stringify({ policy }), now: input.now });
          sources.push(joined.nodeId);
        }
        continue;
      }

      const failed = transitionWorkflowNodeRunSync({
        workspaceId: input.workspaceId,
        nodeRunId: target.id,
        from: ["pending"],
        to: target.nodeType === "join" ? "failed" : "skipped",
        errorCode: target.nodeType === "join" ? "workflow_join_upstream_failed" : "workflow_upstream_failed",
        finishedAt: input.now,
        now: input.now,
      });
      if (!failed) continue;
      byId.set(failed.nodeId, failed);
      appendWorkflowRunEventSync({
        workspaceId: input.workspaceId,
        runId: input.run.id,
        nodeRunId: target.id,
        type: target.nodeType === "join" ? "join.failed" : "node.skipped",
        actorType: "coordinator",
        severity: target.nodeType === "join" ? "error" : undefined,
        dataJson: JSON.stringify(target.nodeType === "join" ? { policy } : { reasonCode: "workflow_upstream_failed" }),
        now: input.now,
      });
      sources.push(failed.nodeId);
    }
  }
}

export function decideWorkflowDownstreamTransition(input: {
  nodeType: WorkflowNodeRunRecord["nodeType"];
  policy: "all_success" | "allow_partial";
  predecessorStatuses: WorkflowNodeRunRecord["status"][];
}): "wait" | "ready" | "succeed_join" | "fail" {
  const terminalStatuses = new Set(["succeeded", "failed", "skipped", "cancelled"]);
  if (!input.predecessorStatuses.every((status) => terminalStatuses.has(status))) return "wait";
  const succeeded = input.predecessorStatuses.filter((status) => status === "succeeded").length;
  if (input.nodeType !== "join") return succeeded === input.predecessorStatuses.length ? "ready" : "fail";
  if (input.policy === "all_success") return succeeded === input.predecessorStatuses.length ? "succeed_join" : "fail";
  return succeeded > 0 ? "succeed_join" : "fail";
}

export function collectWorkflowDescendantNodeIds(
  graph: WorkflowGraphDefinition,
  nodeId: string,
): string[] {
  const descendants: string[] = [];
  const visited = new Set<string>([nodeId]);
  const pending = graph.edges.filter((edge) => edge.source === nodeId).map((edge) => edge.target);
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    descendants.push(current);
    pending.push(...graph.edges.filter((edge) => edge.source === current).map((edge) => edge.target));
  }
  return descendants;
}

const WORKFLOW_RUN_TERMINAL_EVENT: Record<"succeeded" | "partially_succeeded" | "failed", string> = {
  succeeded: "run.succeeded",
  partially_succeeded: "run.partially_succeeded",
  failed: "run.failed",
};

function finalizeRunIfTerminal(workspaceId: string, run: WorkflowRunRecord, now: string): WorkflowRunRecord {
  const nodes = listWorkflowNodeRunsSync(workspaceId, run.id);
  if (nodes.some((node) => ["pending", "ready", "queued", "running", "waiting_approval", "retry_wait"].includes(node.status))) {
    // 首次由 created/queued 进入 running 时补发 run.started；transitionWorkflowRunSync 在
    // 已是 running 时返回 null，因此该事实事件只会发出一次。
    const started = transitionWorkflowRunSync({ workspaceId, runId: run.id, from: ["created", "queued"], to: "running", now });
    if (started) {
      appendWorkflowRunEventSync({ workspaceId, runId: run.id, type: "run.started", actorType: "coordinator", now });
    }
    return readWorkflowRunSync(run.id, workspaceId)!;
  }
  const version = readWorkflowVersionSync(run.versionId, workspaceId);
  if (!version) throw new Error("workflow_version_not_found");
  const terminalStatus = resolveWorkflowRunTerminalStatus(
    nodes,
    JSON.parse(version.graphJson) as WorkflowGraphDefinition,
  );
  const finalized = transitionWorkflowRunSync({ workspaceId, runId: run.id, from: ["created", "queued", "running", "waiting_approval"], to: terminalStatus, finishedAt: now, now });
  // 终态事实事件只发一次：终态后 status 不在 from 列表，transition 返回 null 即跳过。
  if (finalized) {
    appendWorkflowRunEventSync({
      workspaceId,
      runId: run.id,
      type: WORKFLOW_RUN_TERMINAL_EVENT[terminalStatus],
      actorType: "coordinator",
      severity: terminalStatus === "failed" ? "error" : undefined,
      dataJson: JSON.stringify({ status: terminalStatus }),
      now,
    });
  }
  return readWorkflowRunSync(run.id, workspaceId)!;
}

export function resolveWorkflowRunTerminalStatus(
  nodes: Array<Pick<WorkflowNodeRunRecord, "nodeId" | "nodeType" | "status" | "inputJson">>,
  graph: WorkflowGraphDefinition,
): "succeeded" | "partially_succeeded" | "failed" {
  const failures = nodes.filter((node) => node.status === "failed" || node.status === "cancelled");
  if (failures.length === 0) return "succeeded";
  const byNodeId = new Map(nodes.map((node) => [node.nodeId, node]));
  const acceptingPartialJoinIds = new Set(
    graph.nodes
      .filter((definition) => definition.type === "join" && definition.config.policy === "allow_partial")
      .filter((definition) => byNodeId.get(definition.id)?.status === "succeeded")
      .filter((definition) => {
        const predecessorStatuses = graph.edges
          .filter((edge) => edge.target === definition.id)
          .map((edge) => byNodeId.get(edge.source)?.status);
        return predecessorStatuses.some((status) => status !== "succeeded");
      })
      .map((definition) => definition.id),
  );
  if (acceptingPartialJoinIds.size === 0) return "failed";
  const everyFailureWasAccepted = failures.every((failure) => (
    collectWorkflowDescendantNodeIds(graph, failure.nodeId)
      .some((nodeId) => acceptingPartialJoinIds.has(nodeId))
  ));
  return everyFailureWasAccepted ? "partially_succeeded" : "failed";
}

function parseConfig(value: string): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseJson(value?: string): unknown {
  try { return value ? JSON.parse(value) : {}; } catch { return {}; }
}

function parseRecord(value?: string): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}
