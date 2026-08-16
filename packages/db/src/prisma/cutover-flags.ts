export type PrismaCutoverFlagKind = "read" | "shadowRead" | "write";

export interface PrismaCutoverFlagSpec {
  domain: string;
  envPrefix: string;
  stage: "pilot" | "shadow" | "write";
  supportsRead: boolean;
  supportsShadowRead: boolean;
  supportsWrite: boolean;
}

/** The only domain flags accepted by the Prisma migration runtime. */
const registryRows: ReadonlyArray<readonly [string, string, PrismaCutoverFlagSpec["stage"], boolean, boolean, boolean]> = [
  ["agent-access-requests", "AGENT_ACCESS_REQUESTS", "pilot", true, true, false],
  ["agent-skills", "AGENT_SKILLS", "pilot", true, true, false],
  ["attachments", "ATTACHMENTS", "pilot", true, true, false],
  ["audit-log", "AUDIT_LOG", "pilot", true, true, true],
  ["channel-access-requests", "CHANNEL_ACCESS_REQUESTS", "pilot", true, true, false],
  ["channel-invitations", "CHANNEL_INVITATIONS", "pilot", true, true, false],
  ["channel-participants", "CHANNEL_PARTICIPANTS", "pilot", true, true, false],
  ["document-agent-access", "DOCUMENT_AGENT_ACCESS", "pilot", true, true, true],
  ["document-permission-requests", "DOCUMENT_PERMISSION_REQUESTS", "pilot", true, true, false],
  ["employees-runtime-bindings", "EMPLOYEES_RUNTIME_BINDINGS", "pilot", true, true, false],
  ["knowledge-proposals", "KNOWLEDGE_PROPOSALS", "pilot", true, true, false],
  ["notifications", "NOTIFICATIONS", "pilot", true, true, true],
  ["skill-drafts", "SKILL_DRAFTS", "write", false, false, true],
  ["skill-service-catalog", "SKILL_SERVICE_CATALOG", "pilot", true, true, false],
  ["task-execution-events", "TASK_EXECUTION_EVENTS", "pilot", true, true, false],
  ["task-queue", "TASK_QUEUE", "pilot", true, true, false],
  ["workflow-definitions", "WORKFLOW_DEFINITIONS", "pilot", true, true, false],
  ["workflow-node-runs", "WORKFLOW_NODE_RUNS", "pilot", true, true, false],
  ["workflow-runs", "WORKFLOW_RUNS", "pilot", true, true, false],
  ["workflow-triggers", "WORKFLOW_TRIGGERS", "pilot", true, true, false],
  ["workflow-versions", "WORKFLOW_VERSIONS", "pilot", true, true, false],
  ["workspace-memberships", "WORKSPACE_MEMBERSHIPS", "pilot", true, true, false],
  ["workspace-skills", "WORKSPACE_SKILLS", "pilot", true, true, false],
];

export const PRISMA_CUTOVER_FLAG_REGISTRY: readonly PrismaCutoverFlagSpec[] = registryRows.map(([domain, envPrefix, stage, supportsRead, supportsShadowRead, supportsWrite]) => ({
  domain,
  envPrefix,
  stage,
  supportsRead,
  supportsShadowRead,
  supportsWrite,
})) satisfies readonly PrismaCutoverFlagSpec[];

const FLAG_PATTERN = /^([A-Z0-9_]+)_PRISMA_(READ|SHADOW_READ|WRITE)_ENABLED$/;

/**
 * Validates cutover flags at the process boundary. This keeps typoed flags and
 * unsafe shadow/read combinations from silently changing migration behaviour.
 */
export function assertPrismaCutoverFlagsValid(env: NodeJS.ProcessEnv = process.env): void {
  const specs = new Map(PRISMA_CUTOVER_FLAG_REGISTRY.map((spec) => [spec.envPrefix, spec]));
  const configured = Object.keys(env).filter((key) => FLAG_PATTERN.test(key));
  for (const key of configured) {
    const match = key.match(FLAG_PATTERN);
    if (!match?.[1] || !match[2]) continue;
    const spec = specs.get(match[1]);
    if (!spec) throw new Error(`Unknown Prisma cutover flag: ${key}`);
    const value = env[key];
    if (value !== "0" && value !== "1") {
      throw new Error(`Prisma cutover flag ${key} must be "0" or "1".`);
    }
    const kind = normalizeFlagKind(match[2]);
    if (!supportsFlag(spec, kind)) {
      throw new Error(`Prisma cutover flag ${key} is not registered for ${spec.domain}.`);
    }
  }

  for (const spec of PRISMA_CUTOVER_FLAG_REGISTRY) {
    const readEnabled = env[`${spec.envPrefix}_PRISMA_READ_ENABLED`] === "1";
    const shadowEnabled = env[`${spec.envPrefix}_PRISMA_SHADOW_READ_ENABLED`] === "1";
    if (shadowEnabled && !readEnabled) {
      throw new Error(`${spec.envPrefix}_PRISMA_SHADOW_READ_ENABLED requires ${spec.envPrefix}_PRISMA_READ_ENABLED.`);
    }
  }
}

function normalizeFlagKind(value: string): PrismaCutoverFlagKind {
  if (value === "SHADOW_READ") return "shadowRead";
  if (value === "WRITE") return "write";
  return "read";
}

function supportsFlag(spec: PrismaCutoverFlagSpec, kind: PrismaCutoverFlagKind): boolean {
  if (kind === "read") return spec.supportsRead;
  if (kind === "shadowRead") return spec.supportsShadowRead;
  return spec.supportsWrite;
}
