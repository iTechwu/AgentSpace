import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ExecutionEngineSelect } from "./execution-engine-select";
import { LanguageProvider } from "@/features/i18n/language-provider";

it("disables a managed runtime while its credential is recovering", async () => {
  const user = userEvent.setup();
  render(
    <LanguageProvider initialLanguage="en">
      <ExecutionEngineSelect
        label="Execution engine"
        name="runtimeId"
        onChange={vi.fn()}
        options={[{
          id: "runtime-recovering",
          label: "Recovering Codex",
          provider: "codex",
          status: "offline",
          providerHealth: { providerUsable: "unknown" },
          serverName: "Managed",
          daemonKey: "",
          mode: "remote",
          managed: true,
          provisioningState: "credential_recovering",
          bindable: false,
        }]}
        placeholder="Select an execution engine"
        value=""
      />
    </LanguageProvider>,
  );

  await user.click(screen.getByRole("button", { name: "Execution engine" }));

  expect(screen.getByRole("option", { name: /Recovering Codex/ })).toBeDisabled();
  expect(screen.getByText("Credential recovery in progress")).toBeInTheDocument();
});
