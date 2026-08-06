export function resolveWorkflowNodeInput(input: {
  runInput: Record<string, unknown>;
  nodeConfig: Record<string, unknown>;
  predecessorOutputs: Record<string, Record<string, unknown>>;
}): Record<string, unknown> {
  const source = input.nodeConfig.input;
  if (source === undefined) return {};
  return resolveValue(source, input) as Record<string, unknown>;
}

function resolveValue(value: unknown, context: {
  runInput: Record<string, unknown>;
  predecessorOutputs: Record<string, Record<string, unknown>>;
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
}): unknown {
  const parts = path.split(".");
  let current: unknown;
  if (parts[0] === "run" && parts[1] === "input") current = context.runInput;
  else if (parts[0] === "nodes" && parts[1] && parts[2] === "output") current = context.predecessorOutputs[parts[1]];
  else if (path === "join.outputs") current = context.predecessorOutputs;
  else throw new Error("workflow_input_reference_missing");
  for (const part of parts.slice(path === "join.outputs" ? 2 : parts[0] === "run" ? 2 : 3)) {
    if (!current || typeof current !== "object" || !(part in (current as Record<string, unknown>))) {
      throw new Error("workflow_input_reference_missing");
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
