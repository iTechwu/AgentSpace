import type { DaemonSkillRunnerEntrypoint } from "@dofe-agent/domain";

export function partitionSkillEnvironment(
  skillEnv: Readonly<Record<string, string>> | undefined,
  entrypoints: readonly Pick<DaemonSkillRunnerEntrypoint, "configKeys">[],
): { runnerEnv: Record<string, string>; providerEnv: Record<string, string> } {
  const runnerKeys = new Set(entrypoints.flatMap((entrypoint) => entrypoint.configKeys ?? []));
  const runnerEnv: Record<string, string> = {};
  const providerEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(skillEnv ?? {})) {
    if (runnerKeys.has(key)) runnerEnv[key] = value;
    else providerEnv[key] = value;
  }
  return { runnerEnv, providerEnv };
}
