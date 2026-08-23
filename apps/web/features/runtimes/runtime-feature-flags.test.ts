import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_PROVIDER_IDS } from "@dofe-agent/domain";
import {
  assertManagedRuntimeProviderEnabled,
  isDeepSeekHarnessRuntimeEnabled,
  listCreatableManagedRuntimeProviders,
} from "./runtime-feature-flags";

describe("DeepSeek Harness runtime feature flag", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the provider disabled by default", () => {
    vi.stubEnv("NEXT_PUBLIC_DEEPSEEK_HARNESS_RUNTIME_ENABLED", "0");

    expect(isDeepSeekHarnessRuntimeEnabled()).toBe(false);
    expect(listCreatableManagedRuntimeProviders()).not.toContain("deepseek-harness");
    expect(listCreatableManagedRuntimeProviders()).toEqual(
      DAEMON_PROVIDER_IDS.filter((provider) => provider !== "deepseek-harness"),
    );
    expect(() => assertManagedRuntimeProviderEnabled("deepseek-harness")).toThrow(
      "managed_runtime.deepseek_harness_disabled",
    );
  });

  it("accepts only the explicit canary value", () => {
    for (const value of ["", "true", "True", "yes", "01"]) {
      vi.stubEnv("NEXT_PUBLIC_DEEPSEEK_HARNESS_RUNTIME_ENABLED", value);
      expect(isDeepSeekHarnessRuntimeEnabled()).toBe(false);
      expect(listCreatableManagedRuntimeProviders()).not.toContain("deepseek-harness");
    }

    vi.stubEnv("NEXT_PUBLIC_DEEPSEEK_HARNESS_RUNTIME_ENABLED", "1");
    expect(isDeepSeekHarnessRuntimeEnabled()).toBe(true);
    expect(listCreatableManagedRuntimeProviders()).toContain("deepseek-harness");
    expect(() => assertManagedRuntimeProviderEnabled("deepseek-harness")).not.toThrow();
  });
});
