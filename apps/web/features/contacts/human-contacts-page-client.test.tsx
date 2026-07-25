import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HumanContactsPageClient } from "@/features/contacts/human-contacts-page-client";
import { LanguageProvider } from "@/features/i18n/language-provider";

const {
  routerPushMock,
  routerRefreshMock,
  sendHumanDirectMessageActionMock,
} = vi.hoisted(() => ({
  routerPushMock: vi.fn(),
  routerRefreshMock: vi.fn(),
  sendHumanDirectMessageActionMock: vi.fn<(formData: FormData) => Promise<void>>(async () => {}),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
    refresh: routerRefreshMock,
  }),
  usePathname: () => "/w/workspace-alpha/contacts",
}));

vi.mock("@/features/channels/actions", () => ({
  inviteExternalContactToChannelAction: vi.fn(async () => ({
    invitationId: "channel-invite-1",
    invitePath: "/channel-invite/channel-invite-1",
  })),
  sendHumanDirectMessageAction: sendHumanDirectMessageActionMock,
}));

function mockMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches,
      media: "(max-width: 860px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("HumanContactsPageClient", () => {
  beforeEach(() => {
    mockMatchMedia(false);
    routerPushMock.mockReset();
    routerRefreshMock.mockReset();
    sendHumanDirectMessageActionMock.mockClear();
  });

  it("keeps contact type switching in the page container", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider initialLanguage="zh">
        <HumanContactsPageClient
          channels={[]}
          contacts={[]}
          currentUserDisplayName="techwu"
          threads={[]}
        />
      </LanguageProvider>,
    );

    expect(screen.getByRole("tab", { name: "真人" })).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: "数字员工" }));
    expect(routerPushMock).toHaveBeenCalledWith("/w/workspace-alpha/im?view=direct&context=contacts");
  });

  it("sends a direct message to a selected workspace member", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <HumanContactsPageClient
          channels={["general"]}
          contacts={[
            {
              id: "user-mina",
              name: "Mina",
              subtitle: "Member / mina@example.com",
              email: "mina@example.com",
              role: "Member",
            },
          ]}
          currentUserDisplayName="techwu"
          threads={[
            {
              contactId: "user-mina",
              messages: [],
            },
          ]}
        />
      </LanguageProvider>,
    );

    await user.type(screen.getByPlaceholderText("发送给 Mina"), "hello Mina");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => {
      expect(sendHumanDirectMessageActionMock).toHaveBeenCalledTimes(1);
    });
    const formData = sendHumanDirectMessageActionMock.mock.calls[0]?.[0];
    expect(formData?.get("targetUserId")).toBe("user-mina");
    expect(formData?.get("content")).toBe("hello Mina");
    expect(routerRefreshMock).toHaveBeenCalled();
  });

  it("shows contact profile only from the chat avatar popover", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <HumanContactsPageClient
          channels={["general"]}
          contacts={[
            {
              id: "user-mina",
              name: "Mina",
              subtitle: "Member / mina@example.com",
              email: "mina@example.com",
              role: "Member",
            },
          ]}
          currentUserDisplayName="techwu"
          threads={[
            {
              contactId: "user-mina",
              messages: [],
            },
          ]}
        />
      </LanguageProvider>,
    );

    expect(screen.queryByRole("dialog", { name: "联系人资料" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "查看 Mina 的资料" }));

    const profile = await screen.findByRole("dialog", { name: "联系人资料" });
    expect(profile).toHaveTextContent("mina@example.com");
    expect(profile).toHaveTextContent("Member");
  });
});
