import { DAEMON_PROVIDER_IDS, type DaemonProvider } from "@dofe-agent/domain";

const DEEPSEEK_HARNESS_PROVIDER: DaemonProvider = "deepseek-harness";

export function isDeepSeekHarnessRuntimeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DEEPSEEK_HARNESS_RUNTIME_ENABLED === "1";
}

export function listCreatableManagedRuntimeProviders(): DaemonProvider[] {
  return DAEMON_PROVIDER_IDS.filter((provider) => (
    provider !== DEEPSEEK_HARNESS_PROVIDER || isDeepSeekHarnessRuntimeEnabled()
  ));
}

export function assertManagedRuntimeProviderEnabled(provider: DaemonProvider): void {
  if (provider === DEEPSEEK_HARNESS_PROVIDER && !isDeepSeekHarnessRuntimeEnabled()) {
    throw new Error("managed_runtime.deepseek_harness_disabled");
  }
}
