import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkflowDefinitionSync,
  createWorkflowRunSync,
  getDatabase,
  listWorkflowNodeRunsSync,
  listWorkflowRunEventsSync,
  materializeWorkflowNodeRunsSync,
  publishWorkflowVersionSync,
  readWorkflowRunSync,
  upsertWorkspaceMembershipSync,
} from "@dofe-agent/db";
import { listApprovalsSync } from "../approvals/approvals.ts";
import { createWorkflowApprovalSync, reviewWorkflowApprovalSync } from "./approvals.ts";
import { expireWorkflowApprovalsSync } from "./coordinator.ts";
// 审批闭环走的是遗留 workspace-state 快照（workspace_snapshot.state_json），
// createApprovalRequestSync 会校验 agentId∈activeEmployees、channel∈channels，
// 因此必须在快照里写入员工与渠道，而不是只写 workspace_employee 表。
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";

const hasTestDatabase = Boolean(
  process.env.DOFE_AGENT_TEST_DATABASE_URL_OVERRIDE
  || process.env.DOFE_AGENT_TEST_DATABASE_URL
  || process.env.DOFE_AGENT_PG_TEST_URL,
);

interface Fixture {
  workspaceId: string;
  workflowId: string;
  versionId: string;
  // 每个测试夹具使用独立的员工/用户 id：idx_workspace_employee_id 是全局唯一约束、users 表
  // 也在并发运行时共享——固定 ID 会在多夹具/并发测试中触发重复键、死锁与级联夹具失败。
  employeeId: string;
  reviewerUserId: string;
  adminUserId: string;
  memberUserId: string;
}

/** 种入工作区、成员（指定审批人=member、管理员、普通成员）、审批员工与单审批节点工作流版本。 */
function seedFixture(): Fixture {
  const suffix = Math.random().toString(36).slice(2, 8);
  const workspaceId = `workflow-approval-auth-${suffix}`;
  const workflowId = `wf-approval-${suffix}`;
  const versionId = `wv-approval-${suffix}`;
  const employeeId = `approval-employee-${suffix}`;
  const reviewerUserId = `approval-reviewer-${suffix}`;
  const adminUserId = `approval-admin-${suffix}`;
  const memberUserId = `approval-member-${suffix}`;
  const now = "2026-08-07T01:00:00.000Z";
  const db = getDatabase();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(workspaceId, workspaceId, workspaceId, reviewerUserId, now, now);
  for (const userId of [reviewerUserId, adminUserId, memberUserId]) {
    db.prepare(
      `INSERT INTO users (id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    ).run(userId, userId, now, now);
  }
  // 指定审批人本身是普通成员；管理员用于越权放行；另一名普通成员用于证明「成员但不被指定」会被拦。
  upsertWorkspaceMembershipSync({ workspaceId, userId: reviewerUserId, role: "member" });
  upsertWorkspaceMembershipSync({ workspaceId, userId: adminUserId, role: "admin" });
  upsertWorkspaceMembershipSync({ workspaceId, userId: memberUserId, role: "member" });
  // 把审批挂载员工与渠道写入工作区状态快照；writeWorkspaceStateSync 同时落
  // workspace_employee 表与 state_json，使 createApprovalRequestSync 的校验通过，
  // 并以 employeeId 作为员工主键供 createWorkflowApprovalSync 取用。
  const base = ensureWorkspaceStateSync(workspaceId);
  writeWorkspaceStateSync(
    {
      ...base,
      activeEmployees: [
        {
          id: employeeId,
          name: "审批员工",
          role: "Agent",
          remarkName: "审批员工",
          ownerUserId: reviewerUserId,
          origin: "manual",
          summary: "审批节点挂载员工",
          traits: [],
          fit: "Ready",
          skillIds: [],
          channels: ["审批群"],
          status: "active",
        },
      ],
      channels: [
        {
          name: "审批群",
          kind: "group",
          humanMemberNames: [],
          humanMembers: 0,
          employeeNames: ["审批员工"],
        },
      ],
    },
    workspaceId,
    { skipVersionCheck: true },
  );
  createWorkflowDefinitionSync({ id: workflowId, workspaceId, name: "Approval auth", ownerUserId: reviewerUserId, createdBy: reviewerUserId, now });
  publishWorkflowVersionSync({
    id: versionId,
    workspaceId,
    workflowId,
    graphJson: '{"schemaVersion":1,"nodes":[{"id":"approval","type":"approval","config":{"policy":"all_success"}}],"edges":[]}',
    contentHash: `sha256:${suffix}`,
    publishedBy: reviewerUserId,
    now,
  });
  return { workspaceId, workflowId, versionId, employeeId, reviewerUserId, adminUserId, memberUserId };
}

/** 创建一条运行并把审批节点推进到 waiting_approval，绑定指定审批人。返回审批 id。 */
function createPendingApproval(fixture: Fixture, options?: { deadlineSeconds?: number }): { runId: string; approvalId: string } {
  const now = "2026-08-07T01:00:00.000Z";
  const run = createWorkflowRunSync({
    workspaceId: fixture.workspaceId,
    workflowId: fixture.workflowId,
    versionId: fixture.versionId,
    triggerType: "manual",
    triggerKey: `approval-auth:${fixture.workspaceId}:${Math.random().toString(36).slice(2, 8)}`,
    inputJson: "{}",
  });
  materializeWorkflowNodeRunsSync({
    workspaceId: fixture.workspaceId,
    runId: run.id,
    nodes: [{ nodeId: "approval", nodeType: "approval" }],
  });
  const approval = createWorkflowApprovalSync({
    workspaceId: fixture.workspaceId,
    runId: run.id,
    nodeId: "approval",
    employeeId: fixture.employeeId,
    channelName: "审批群",
    contentPreview: "请审批发布内容。",
    reviewerUserId: fixture.reviewerUserId,
    ...(options?.deadlineSeconds ? { deadlineSeconds: options.deadlineSeconds } : {}),
    now,
  });
  return { runId: run.id, approvalId: approval.id };
}

function cleanup(fixture: Fixture): void {
  const db = getDatabase();
  for (const userId of [fixture.reviewerUserId, fixture.adminUserId, fixture.memberUserId]) {
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  }
  db.prepare("DELETE FROM workspace WHERE id = ?").run(fixture.workspaceId);
}

test("approval auth closure blocks non-designated members and admits the designated reviewer and managers", {
  skip: !hasTestDatabase,
}, () => {
  const fixture = seedFixture();
  try {
    // 1) 普通成员（非指定、非管理员）审批被拒绝，审批仍处于 pending。
    const first = createPendingApproval(fixture);
    assert.throws(
      () => reviewWorkflowApprovalSync({ workspaceId: fixture.workspaceId, approvalId: first.approvalId, decision: "approved", actorUserId: fixture.memberUserId }),
      /workflow_approval_reviewer_unauthorized/,
    );
    assert.equal(readWorkflowRunSync(first.runId, fixture.workspaceId)?.status, "waiting_approval");

    // 2) 指定审批人放行，运行推进到终态 succeeded。
    const firstRun = reviewWorkflowApprovalSync({ workspaceId: fixture.workspaceId, approvalId: first.approvalId, decision: "approved", actorUserId: fixture.reviewerUserId });
    assert.equal(firstRun.status, "succeeded");

    // 3) 管理员（非指定）越权放行同样成功。
    const second = createPendingApproval(fixture);
    const secondRun = reviewWorkflowApprovalSync({ workspaceId: fixture.workspaceId, approvalId: second.approvalId, decision: "approved", actorUserId: fixture.adminUserId });
    assert.equal(secondRun.status, "succeeded");
  } finally {
    cleanup(fixture);
  }
});

test("approval without a designated reviewer falls back to managers only", {
  skip: !hasTestDatabase,
}, () => {
  const fixture = seedFixture();
  try {
    const now = "2026-08-07T01:00:00.000Z";
    const first = createWorkflowRunSync({
      workspaceId: fixture.workspaceId,
      workflowId: fixture.workflowId,
      versionId: fixture.versionId,
      triggerType: "manual",
      triggerKey: `approval-open-block:${fixture.workspaceId}:${Math.random().toString(36).slice(2, 8)}`,
      inputJson: "{}",
    });
    materializeWorkflowNodeRunsSync({ workspaceId: fixture.workspaceId, runId: first.id, nodes: [{ nodeId: "approval", nodeType: "approval" }] });
    const firstApproval = createWorkflowApprovalSync({
      workspaceId: fixture.workspaceId,
      runId: first.id,
      nodeId: "approval",
      employeeId: fixture.employeeId,
      channelName: "审批群",
      contentPreview: "请审批发布内容。",
      now,
    });
    // 未指定审批人时，与 UI「默认（管理员/负责人）」、Web Action 管理员要求一致：
    // 普通成员无权审批，审批仍处于 pending。
    assert.throws(
      () => reviewWorkflowApprovalSync({ workspaceId: fixture.workspaceId, approvalId: firstApproval.id, decision: "approved", actorUserId: fixture.memberUserId }),
      /workflow_approval_reviewer_unauthorized/,
    );
    assert.equal(readWorkflowRunSync(first.id, fixture.workspaceId)?.status, "waiting_approval");

    // 管理员可作为默认审批人放行，运行推进到终态 succeeded。
    const firstRun = reviewWorkflowApprovalSync({ workspaceId: fixture.workspaceId, approvalId: firstApproval.id, decision: "approved", actorUserId: fixture.adminUserId });
    assert.equal(firstRun.status, "succeeded");
  } finally {
    cleanup(fixture);
  }
});

test("auto-rejects an approval after its deadline elapses and distinguishes the failure code", {
  skip: !hasTestDatabase,
}, () => {
  const fixture = seedFixture();
  try {
    const now = "2026-08-07T01:00:00.000Z";
    // 创建一条带 1 小时限时的审批，并推进到 waiting_approval。
    const run = createWorkflowRunSync({
      workspaceId: fixture.workspaceId,
      workflowId: fixture.workflowId,
      versionId: fixture.versionId,
      triggerType: "manual",
      triggerKey: `approval-deadline:${fixture.workspaceId}:${Math.random().toString(36).slice(2, 8)}`,
      inputJson: "{}",
    });
    materializeWorkflowNodeRunsSync({
      workspaceId: fixture.workspaceId,
      runId: run.id,
      nodes: [{ nodeId: "approval", nodeType: "approval" }],
    });
    const approval = createWorkflowApprovalSync({
      workspaceId: fixture.workspaceId,
      runId: run.id,
      nodeId: "approval",
      employeeId: fixture.employeeId,
      channelName: "审批群",
      contentPreview: "请审批发布内容。",
      deadlineSeconds: 3600,
      now,
    });

    // 1) 限时未到（now 仅过 30 分钟）：扫描不应处理该审批。
    const beforeExpiry = expireWorkflowApprovalsSync({ now: "2026-08-07T01:30:00.000Z" });
    assert.deepEqual(beforeExpiry.expiredApprovalIds, []);
    assert.equal(readWorkflowRunSync(run.id, fixture.workspaceId)?.status, "waiting_approval");

    // 2) 限时已过（now 推进到 2 小时后）：扫描应自动驳回。
    const sweep = expireWorkflowApprovalsSync({ now: "2026-08-07T03:00:00.000Z" });
    assert.deepEqual(sweep.expiredApprovalIds, [approval.id]);

    const failedRun = readWorkflowRunSync(run.id, fixture.workspaceId);
    assert.equal(failedRun?.status, "failed");
    const nodeRun = listWorkflowNodeRunsSync(fixture.workspaceId, run.id).find((item) => item.nodeId === "approval");
    assert.equal(nodeRun?.status, "failed");
    assert.equal(nodeRun?.errorCode, "workflow_approval_deadline_exceeded");
    // 审批记录自身被标记为 rejected，避免下一轮重复扫描。
    const approvalRecord = listApprovalsSync(fixture.workspaceId).find((item) => item.id === approval.id);
    assert.equal(approvalRecord?.status, "rejected");

    // 3) 幂等：再次扫描同一工作区不会重复处理已驳回的审批。
    const secondSweep = expireWorkflowApprovalsSync({ now: "2026-08-07T04:00:00.000Z" });
    assert.deepEqual(secondSweep.expiredApprovalIds, []);
  } finally {
    cleanup(fixture);
  }
});

test("approval as the root node emits run.started and traverses running before waiting_approval", {
  skip: !hasTestDatabase,
}, () => {
  // Run 生命周期（业务架构文档:88）：审批作为根节点也必须 created → running → waiting_approval，
  // 并在 running 处补发 run.started 事实事件。原先直接 created/queued → waiting_approval，
  // 跳过 running，导致审批首节点运行的 run.started 缺失。
  const fixture = seedFixture();
  try {
    const now = "2026-08-07T01:00:00.000Z";
    const run = createWorkflowRunSync({
      workspaceId: fixture.workspaceId,
      workflowId: fixture.workflowId,
      versionId: fixture.versionId,
      triggerType: "manual",
      triggerKey: `approval-root-started:${fixture.workspaceId}:${Math.random().toString(36).slice(2, 8)}`,
      inputJson: "{}",
    });
    materializeWorkflowNodeRunsSync({ workspaceId: fixture.workspaceId, runId: run.id, nodes: [{ nodeId: "approval", nodeType: "approval" }] });
    const approval = createWorkflowApprovalSync({
      workspaceId: fixture.workspaceId,
      runId: run.id,
      nodeId: "approval",
      employeeId: fixture.employeeId,
      channelName: "审批群",
      contentPreview: "请审批发布内容。",
      now,
    });

    assert.equal(readWorkflowRunSync(run.id, fixture.workspaceId)?.status, "waiting_approval");
    const types = listWorkflowRunEventsSync(fixture.workspaceId, run.id).map((event) => event.type);
    assert.ok(types.includes("run.started"), `expected run.started in ${JSON.stringify(types)}`);
    assert.equal(types.filter((type) => type === "run.started").length, 1, "run.started must be emitted exactly once");
    assert.ok(types.includes("approval.requested"), `expected approval.requested in ${JSON.stringify(types)}`);
    // 生命周期顺序：run.started 必须早于 approval.requested。
    assert.ok(types.indexOf("run.started") < types.indexOf("approval.requested"), "run.started must precede approval.requested");
    assert.ok(approval.id);
  } finally {
    cleanup(fixture);
  }
});

test("approval deadline scan rejects an unparseable clock without mass-rejecting", {
  skip: !hasTestDatabase,
}, () => {
  // 非法时钟回归：Date.parse("not-a-valid-date") 返回 NaN，原先 `expiresAt > NaN` 恒为 false，
  // 会导致所有合法限时审批在扫描时被批量误驳回。现在必须在进入扫描前拒绝扫描本身，
  // 并保证审批与运行状态不受影响。
  const fixture = seedFixture();
  try {
    const { runId, approvalId } = createPendingApproval(fixture, { deadlineSeconds: 3600 });
    assert.throws(
      () => expireWorkflowApprovalsSync({ now: "not-a-valid-date" }),
      /workflow_now_invalid/,
    );
    const approvalRecord = listApprovalsSync(fixture.workspaceId).find((item) => item.id === approvalId);
    assert.equal(approvalRecord?.status, "pending");
    assert.equal(readWorkflowRunSync(runId, fixture.workspaceId)?.status, "waiting_approval");
  } finally {
    cleanup(fixture);
  }
});

test("approval deadline scan stays within the requested workspace", {
  skip: !hasTestDatabase,
}, () => {
  // 工作区隔离：调度器以工作区范围调用扫描时，绝不能越界处理其他工作区的审批。
  const ws1 = seedFixture();
  const ws2 = seedFixture();
  try {
    const a = createPendingApproval(ws1, { deadlineSeconds: 3600 });
    const b = createPendingApproval(ws2, { deadlineSeconds: 3600 });
    const sweep = expireWorkflowApprovalsSync({ now: "2026-08-07T03:00:00.000Z", workspaceId: ws1.workspaceId });
    assert.deepEqual(sweep.expiredApprovalIds, [a.approvalId]);
    // ws2 的审批与运行保持原状，未被越界驳回。
    assert.equal(readWorkflowRunSync(b.runId, ws2.workspaceId)?.status, "waiting_approval");
    const ws2Approval = listApprovalsSync(ws2.workspaceId).find((item) => item.id === b.approvalId);
    assert.equal(ws2Approval?.status, "pending");
  } finally {
    cleanup(ws1);
    cleanup(ws2);
  }
});

test("approval deadline scan rolls back and reports a structured failure when finalization conflicts", {
  skip: !hasTestDatabase,
}, () => {
  // 事务原子性 + 可观测性：当终结审批时 run 状态冲突（completeWorkflowApprovalNodeSync 抛
  // workflow_run_control_conflict），整个审批事务回滚（审批仍 pending），失败以结构化 failures
  // 上报（含 workspaceId/runId/approvalId/errorCode）并写入审计日志，不再被静默吞掉。
  const fixture = seedFixture();
  try {
    const now = "2026-08-07T01:00:00.000Z";
    const { runId, approvalId } = createPendingApproval(fixture, { deadlineSeconds: 3600 });
    // 人为把 run 置为终态 succeeded（节点仍 waiting_approval）：终结时 transitionWorkflowRunSync
    // 的 from 列表不含 succeeded → 返回 null → 抛 workflow_run_control_conflict。
    getDatabase().prepare("UPDATE workflow_run SET status = 'succeeded', updated_at = ? WHERE id = ?").run(now, runId);

    const sweep = expireWorkflowApprovalsSync({ now: "2026-08-07T03:00:00.000Z", workspaceId: fixture.workspaceId });
    assert.deepEqual(sweep.expiredApprovalIds, []);
    assert.equal(sweep.failures.length, 1);
    assert.equal(sweep.failures[0]?.approvalId, approvalId);
    assert.equal(sweep.failures[0]?.errorCode, "workflow_run_control_conflict");
    assert.equal(sweep.failures[0]?.workspaceId, fixture.workspaceId);
    assert.equal(sweep.failures[0]?.runId, runId);
    // 事务回滚：审批仍是 pending，run 仍为 succeeded（未被部分驳回），下一轮 tick 可重试。
    const approvalRecord = listApprovalsSync(fixture.workspaceId).find((item) => item.id === approvalId);
    assert.equal(approvalRecord?.status, "pending");
    assert.equal(readWorkflowRunSync(runId, fixture.workspaceId)?.status, "succeeded");
  } finally {
    cleanup(fixture);
  }
});

test("approval deadline scan reports an unparseable expiresAt as a structured failure", {
  skip: !hasTestDatabase,
}, () => {
  // 非法 expiresAt 回归：发布预检校验新配置，但历史 JSON、迁移数据或人工修改仍可能留下
  // 无法解析的截止时间。原先扫描对 Date.parse NaN 静默 continue，这类审批既不会自动终结、
  // 也不出现在 failures 或告警出口，永久悬挂。现在记为稳定错误码 workflow_approval_deadline_invalid、
  // 写结构化审计并按失败上报（不自动驳回——没有有效截止时间就没有终结依据），交由 on-call 介入。
  const fixture = seedFixture();
  try {
    // 先建一条合法限时审批并把 run 推进到 waiting_approval，使工作区进入扫描视野。
    const { approvalId } = createPendingApproval(fixture, { deadlineSeconds: 3600 });
    // 模拟历史脏数据：把合法 expiresAt 改写为无法解析的字符串。
    const state = ensureWorkspaceStateSync(fixture.workspaceId);
    const target = state.approvals.find((item) => item.id === approvalId);
    assert.ok(target, "approval seed missing");
    target.metadata = { ...(target.metadata ?? {}), expiresAt: "not-a-valid-date" };
    writeWorkspaceStateSync(state, fixture.workspaceId, { skipVersionCheck: true });

    const sweep = expireWorkflowApprovalsSync({ now: "2026-08-07T01:30:00.000Z", workspaceId: fixture.workspaceId });
    assert.deepEqual(sweep.expiredApprovalIds, []);
    assert.equal(sweep.failures.length, 1);
    assert.equal(sweep.failures[0]?.approvalId, approvalId);
    assert.equal(sweep.failures[0]?.errorCode, "workflow_approval_deadline_invalid");
    // 审批未被自动驳回，仍 pending，等待 on-call 经告警介入。
    const approvalRecord = listApprovalsSync(fixture.workspaceId).find((item) => item.id === approvalId);
    assert.equal(approvalRecord?.status, "pending");
  } finally {
    cleanup(fixture);
  }
});
