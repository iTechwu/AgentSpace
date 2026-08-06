import type { WorkflowGraphDefinition } from "@dofe-agent/domain";

export function resolveWorkflowNodeInput(input: {
  runInput: Record<string, unknown>;
  nodeConfig: Record<string, unknown>;
  predecessorOutputs: Record<string, Record<string, unknown>>;
  joinOutputs?: Record<string, unknown>;
}): Record<string, unknown> {
  const source = input.nodeConfig.input;
  if (source === undefined) return {};
  return resolveValue(source, input) as Record<string, unknown>;
}

function resolveValue(value: unknown, context: {
  runInput: Record<string, unknown>;
  predecessorOutputs: Record<string, Record<string, unknown>>;
  joinOutputs?: Record<string, unknown>;
}): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, context)]));
  }
  if (typeof value !== "string") return value;
  const exact = /^\$\{([^}]+)\}$/.exec(value);
  if (exact) return resolvePath(exact[1]!, context);
  return value.replace(/\$\{([^}]+)\}/g, (_match, path: string) => String(resolvePath(path, context)));
}

function resolvePath(path: string, context: {
  runInput: Record<string, unknown>;
  predecessorOutputs: Record<string, Record<string, unknown>>;
  joinOutputs?: Record<string, unknown>;
}): unknown {
  const parts = path.split(".");
  let current: unknown;
  if (parts[0] === "run" && parts[1] === "input") current = context.runInput;
  else if (parts[0] === "nodes" && parts[1] && parts[2] === "output") current = context.predecessorOutputs[parts[1]];
  else if (path === "join.outputs") current = context.joinOutputs ?? context.predecessorOutputs;
  else throw new Error("workflow_input_reference_missing");
  for (const part of parts.slice(path === "join.outputs" ? 2 : parts[0] === "run" ? 2 : 3)) {
    if (!current || typeof current !== "object" || !(part in (current as Record<string, unknown>))) {
      throw new Error("workflow_input_reference_missing");
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export interface WorkflowNodeRuntimeRecord {
  nodeId: string;
  nodeType: string;
  status: string;
  outputJson?: string;
  artifactManifestJson?: string;
}

export interface WorkflowNodeRuntimeContext {
  nodeConfig: Record<string, unknown>;
  resolvedInput: Record<string, unknown>;
  artifactRefs: string[];
}

export function getWorkflowInputResolutionErrorCode(error: unknown):
  | "workflow_input_reference_missing"
  | "workflow_version_node_missing"
  | undefined {
  if (!(error instanceof Error)) return undefined;
  return error.message === "workflow_input_reference_missing" || error.message === "workflow_version_node_missing"
    ? error.message
    : undefined;
}

export function buildWorkflowNodeRuntimeContext(input: {
  graph: WorkflowGraphDefinition;
  nodeId: string;
  runInput: Record<string, unknown>;
  nodeRuns: WorkflowNodeRuntimeRecord[];
}): WorkflowNodeRuntimeContext {
  const node = input.graph.nodes.find((candidate) => candidate.id === input.nodeId);
  if (!node) throw new Error("workflow_version_node_missing");
  const byNodeId = new Map(input.nodeRuns.map((candidate) => [candidate.nodeId, candidate]));
  const ancestorIds = collectAncestorNodeIds(input.graph, input.nodeId);
  const predecessorOutputs = Object.fromEntries(
    [...ancestorIds]
      .map((nodeId) => byNodeId.get(nodeId))
      .filter((candidate): candidate is WorkflowNodeRuntimeRecord => candidate?.status === "succeeded")
      .map((candidate) => [candidate.nodeId, parseRecord(candidate.outputJson)]),
  );
  const directPredecessors = input.graph.edges
    .filter((edge) => edge.target === input.nodeId)
    .map((edge) => byNodeId.get(edge.source))
    .filter((candidate): candidate is WorkflowNodeRuntimeRecord => Boolean(candidate));
  const joinOutputs = directPredecessors
    .filter((candidate) => candidate.nodeType === "join")
    .map((candidate) => parseRecord(candidate.outputJson).outputs)
    .find(isRecord);

  return {
    nodeConfig: node.config,
    resolvedInput: resolveWorkflowNodeInput({
      runInput: input.runInput,
      nodeConfig: node.config,
      predecessorOutputs,
      joinOutputs,
    }),
    artifactRefs: collectWorkflowArtifactRefs(
      directPredecessors.map((candidate) => candidate.artifactManifestJson),
    ),
  };
}

export interface WorkflowInputReferenceError {
  code: "workflow_input_reference_invalid" | "workflow_input_reference_not_upstream" | "workflow_join_reference_missing";
  nodeId: string;
  detail: string;
}

export function validateWorkflowInputReferences(graph: WorkflowGraphDefinition): WorkflowInputReferenceError[] {
  const errors: WorkflowInputReferenceError[] = [];
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const nodeTypes = new Map(graph.nodes.map((node) => [node.id, node.type]));
  for (const node of graph.nodes) {
    const ancestors = collectAncestorNodeIds(graph, node.id);
    const hasJoinPredecessor = graph.edges.some((edge) => edge.target === node.id && nodeTypes.get(edge.source) === "join");
    for (const reference of collectReferences(node.config.input)) {
      if (reference === "run.input" || reference.startsWith("run.input.")) continue;
      if (reference === "join.outputs") {
        if (!hasJoinPredecessor) {
          errors.push({ code: "workflow_join_reference_missing", nodeId: node.id, detail: reference });
        }
        continue;
      }
      const match = /^nodes\.([^.]+)\.output(?:\..+)?$/.exec(reference);
      if (!match || !nodeIds.has(match[1]!)) {
        errors.push({ code: "workflow_input_reference_invalid", nodeId: node.id, detail: reference });
      } else if (!ancestors.has(match[1]!)) {
        errors.push({ code: "workflow_input_reference_not_upstream", nodeId: node.id, detail: reference });
      }
    }
  }
  return errors;
}

export function collectWorkflowArtifactRefs(manifests: Array<string | undefined>): string[] {
  const refs = new Set<string>();
  for (const manifest of manifests) {
    for (const artifact of parseArray(manifest)) {
      if (typeof artifact === "string" && artifact.trim()) refs.add(artifact.trim());
      else if (isRecord(artifact) && typeof artifact.id === "string" && artifact.id.trim()) refs.add(artifact.id.trim());
    }
  }
  return [...refs];
}

export function mergeWorkflowArtifactManifests(manifests: Array<string | undefined>): unknown[] {
  const merged = new Map<string, unknown>();
  for (const manifest of manifests) {
    for (const artifact of parseArray(manifest)) {
      const key = isRecord(artifact) && typeof artifact.id === "string"
        ? `id:${artifact.id}`
        : `value:${JSON.stringify(artifact)}`;
      if (!merged.has(key)) merged.set(key, artifact);
    }
  }
  return [...merged.values()];
}

function collectAncestorNodeIds(graph: WorkflowGraphDefinition, nodeId: string): Set<string> {
  const ancestors = new Set<string>();
  const pending = graph.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source);
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || ancestors.has(current)) continue;
    ancestors.add(current);
    pending.push(...graph.edges.filter((edge) => edge.target === current).map((edge) => edge.source));
  }
  return ancestors;
}

function collectReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectReferences);
  if (isRecord(value)) return Object.values(value).flatMap(collectReferences);
  if (typeof value !== "string") return [];
  return [...value.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]!).filter(Boolean);
}

function parseRecord(value?: string): Record<string, unknown> {
  try {
    const parsed = value ? JSON.parse(value) as unknown : {};
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseArray(value?: string): unknown[] {
  try {
    const parsed = value ? JSON.parse(value) as unknown : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
