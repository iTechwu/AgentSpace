import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { FeedbackToastProvider } from "@/shared/ui/feedback-toast-provider";
import { DaemonManagementPanel } from "./daemon-management-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/features/agents/actions", () => ({
  approveRuntimeProvisionAction: vi.fn(),
  createProviderAccountAction: vi.fn(),
  pruneOldOfflineDaemonsAction: vi.fn(),
  requestRuntimeProvisionAction: vi.fn(),
}));

vi.mock("@/features/settings/actions", () => ({
  createDaemonApiTokenAction: vi.fn(),
  revokeDaemonApiTokenAction: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

function renderPanel() {
  return render(
    <LanguageProvider initialLanguage="en">
      <FeedbackToastProvider>
        <DaemonManagementPanel daemonSnapshots={[]} daemonTokens={[]} />
      </FeedbackToastProvider>
    </LanguageProvider>,
  );
}

it("keeps the DeepSeek provider account entry hidden while the runtime flag is disabled", () => {
  vi.stubEnv("NEXT_PUBLIC_DEEPSEEK_HARNESS_RUNTIME_ENABLED", "0");
  renderPanel();

  expect(screen.getByLabelText("Provider")).not.toHaveDisplayValue("DeepSeek Harness");
  expect(screen.queryByRole("option", { name: "DeepSeek Harness" })).not.toBeInTheDocument();
});

it("exposes the DeepSeek provider account entry when its canary flag is enabled", () => {
  vi.stubEnv("NEXT_PUBLIC_DEEPSEEK_HARNESS_RUNTIME_ENABLED", "1");
  renderPanel();

  expect(screen.getByRole("option", { name: "DeepSeek Harness" })).toHaveValue("deepseek-harness");
});
