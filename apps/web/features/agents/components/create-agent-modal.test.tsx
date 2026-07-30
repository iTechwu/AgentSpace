import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { CreateAgentModal } from "./create-agent-modal";

vi.mock("@/features/runtimes/runtime-model-picker", () => ({
  RuntimeModelPicker: () => <div data-testid="runtime-model-picker" />,
}));

const executionEngines = [
  {
    id: "runtime-1",
    label: "First runtime",
    provider: "codex",
    status: "online" as const,
    providerHealth: { providerUsable: "usable" as const },
    serverName: "Server one",
    daemonKey: "daemon-1",
    mode: "remote" as const,
  },
  {
    id: "runtime-2",
    label: "Second runtime",
    provider: "claude",
    status: "online" as const,
    providerHealth: { providerUsable: "usable" as const },
    serverName: "Server two",
    daemonKey: "daemon-2",
    mode: "remote" as const,
  },
];

function renderModal(options = executionEngines) {
  return render(
    <LanguageProvider initialLanguage="en">
      <CreateAgentModal
        canCreate
        containerOptions={options}
        defaultContainerId=""
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        pending={false}
        workspaceSkills={[]}
      />
    </LanguageProvider>,
  );
}

it("keeps a user-selected execution engine when refreshed options have the same values", async () => {
  const user = userEvent.setup();
  const view = renderModal();

  await user.click(screen.getByRole("button", { name: "Execution Engine" }));
  await user.click(screen.getByRole("option", { name: /Second runtime/ }));
  expect(screen.getByRole("button", { name: "Execution Engine" })).toHaveTextContent("Second runtime");

  view.rerender(
    <LanguageProvider initialLanguage="en">
      <CreateAgentModal
        canCreate
        containerOptions={executionEngines.map((engine) => ({ ...engine }))}
        defaultContainerId=""
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        pending={false}
        workspaceSkills={[]}
      />
    </LanguageProvider>,
  );

  expect(screen.getByRole("button", { name: "Execution Engine" })).toHaveTextContent("Second runtime");
});
