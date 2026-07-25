export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { loadRepositoryEnvIntoProcess } = await import("../../packages/db/src/repository-env.ts");
  loadRepositoryEnvIntoProcess({
    override: process.env.DOFE_AGENT_REPOSITORY_ENV_OVERRIDE !== "0",
  });
}
