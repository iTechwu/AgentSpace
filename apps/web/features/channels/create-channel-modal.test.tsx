import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CreateChannelModal, type ChannelMemberCandidate } from "@/features/channels/create-channel-modal";
import { LanguageProvider } from "@/features/i18n/language-provider";

function renderCreateChannelModal(candidates: ChannelMemberCandidate[], onSubmit = vi.fn()) {
  render(
    <LanguageProvider initialLanguage="zh">
      <CreateChannelModal
        candidates={candidates}
        pending={false}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    </LanguageProvider>,
  );
  return onSubmit;
}

describe("CreateChannelModal", () => {
  it("paginates member candidates and keeps selections while searching", async () => {
    const user = userEvent.setup();
    const candidates: ChannelMemberCandidate[] = [
      {
        id: "user-mina",
        label: "Mina",
        kind: "human",
        meta: "mina@example.com",
      },
      ...Array.from({ length: 13 }, (_, index) => {
        const number = `${index + 1}`.padStart(2, "0");
        return {
          id: `agent-${number}`,
          label: `Agent ${number}`,
          kind: "agent" as const,
          meta: `agent-${number}`,
        };
      }),
    ];
    const onSubmit = renderCreateChannelModal(candidates);
    const dialog = screen.getByRole("dialog", { name: "创建群组" });

    expect(within(dialog).getByRole("button", { name: /Agent 07/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Agent 12/ })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "下一页" }));
    await user.click(within(dialog).getByRole("button", { name: /Agent 12/ }));

    const memberSearch = within(dialog).getByRole("searchbox", { name: "群成员" });
    await user.type(memberSearch, "Agent 03");

    expect(within(dialog).getByText("1-1 / 1")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /Agent 03/ }));

    await user.type(within(dialog).getByRole("textbox", { name: "群组名称" }), "Launch Team");
    await user.click(within(dialog).getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        name: "Launch Team",
        humanMemberIds: [],
        agentIds: ["agent-03", "agent-12"],
      });
    });
  });
});
