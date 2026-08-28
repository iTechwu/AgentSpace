import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ExecutionEngineSelect } from "./execution-engine-select";
import { LanguageProvider } from "@/features/i18n/language-provider";

const onlineRuntime = {
  id: "runtime-online",
  label: "Online Codex",
  provider: "codex" as const,
  status: "online" as const,
  providerHealth: {
    runtimeStatus: "online" as const,
    providerHealth: "healthy" as const,
    providerUsable: "usable" as const,
  },
  serverName: "Managed",
  daemonKey: "runtime-online",
  mode: "remote" as const,
  managed: true,
  bindable: true,
  allowNewEmployeeSharing: true,
};

it("restores the trigger after closing or selecting from the execution engine menu", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <LanguageProvider initialLanguage="en">
      <ExecutionEngineSelect
        label="Execution engine"
        name="runtimeId"
        onChange={onChange}
        options={[onlineRuntime]}
        placeholder="Select an execution engine"
        value=""
      />
    </LanguageProvider>,
  );

  const trigger = screen.getByRole("button", { name: "Execution engine" });
  await user.click(trigger);
  const option = screen.getByRole("option", { name: /Online Codex/ });
  await user.tab();
  expect(option).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();

  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: /Online Codex/ }));
  expect(onChange).toHaveBeenCalledWith("runtime-online");
  expect(trigger).toHaveFocus();
});

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
          providerHealth: {
            runtimeStatus: "offline",
            providerHealth: "unknown",
            providerUsable: "unverified",
          },
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

it("disables a managed runtime when its provider is known to be unavailable", async () => {
  const user = userEvent.setup();
  render(
    <LanguageProvider initialLanguage="en">
      <ExecutionEngineSelect
        label="Execution engine"
        name="runtimeId"
        onChange={vi.fn()}
        options={[{
          id: "runtime-broken",
          label: "DeepSeek Harness",
          provider: "deepseek-harness",
          status: "online",
          providerHealth: {
            runtimeStatus: "online",
            providerHealth: "broken",
            providerUsable: "unusable",
            providerHealthReason: "DeepSeek provider verification failed.",
          },
          serverName: "Managed",
          daemonKey: "",
          mode: "remote",
          managed: true,
          provisioningState: "managed",
          bindable: false,
        }]}
        placeholder="Select an execution engine"
        value=""
      />
    </LanguageProvider>,
  );

  await user.click(screen.getByRole("button", { name: "Execution engine" }));

  expect(screen.getByRole("option", { name: /DeepSeek Harness/ })).toBeDisabled();
  expect(screen.getByText("DeepSeek provider verification failed.")).toBeInTheDocument();
});

it("explains the DeepSeek headless session boundary in the runtime option", async () => {
  const user = userEvent.setup();
  render(
    <LanguageProvider initialLanguage="en">
      <ExecutionEngineSelect
        label="Execution engine"
        name="runtimeId"
        onChange={vi.fn()}
        options={[{
          id: "runtime-deepseek",
          label: "DeepSeek Harness",
          provider: "deepseek-harness",
          status: "online",
          providerHealth: {
            runtimeStatus: "online",
            providerHealth: "healthy",
            providerUsable: "usable",
          },
          serverName: "Managed",
          daemonKey: "runtime-deepseek",
          mode: "remote",
          managed: true,
          provisioningState: "managed",
          bindable: true,
          defaultModel: "deepseek-v4-flash",
        }]}
        placeholder="Select an execution engine"
        value=""
      />
    </LanguageProvider>,
  );

  await user.click(screen.getByRole("button", { name: "Execution engine" }));

  expect(screen.getByText("Headless · no resume")).toBeInTheDocument();
});
