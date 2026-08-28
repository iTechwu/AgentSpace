import type { DaemonSkillRunnerEntrypoint } from "@dofe-agent/domain";

export function partitionSkillEnvironment(
  skillEnv: Readonly<Record<string, string>> | undefined,
  entrypoints: readonly Pick<DaemonSkillRunnerEntrypoint, "configKeys">[],
): { runnerEnv: Record<string, string>; providerEnv: Record<string, string> } {
  const runnerKeys = new Set(entrypoints.flatMap((entrypoint) => entrypoint.configKeys ?? []));
  const runnerEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(skillEnv ?? {})) {
    if (runnerKeys.has(key)) runnerEnv[key] = value;
  }
  // Skill requirement values have no persisted secret/config classification in
  // the task bundle. Fail closed: undeclared values are discarded, and no
  // Skill value is ever inherited by the Provider process.
  return { runnerEnv, providerEnv: {} };
}
