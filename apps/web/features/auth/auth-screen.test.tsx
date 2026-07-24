import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { AuthScreen } from "./auth-screen";

describe("AuthScreen", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("uses the server-provided SSO start URL", () => {
    render(<LanguageProvider><AuthScreen ssoStartUrl="https://agentspace.local.dofe.ai/api/auth/sso/start" /></LanguageProvider>);
    expect(screen.getByRole("link", { name: "Continue with Dofe SSO" })).toHaveAttribute(
      "href",
      "https://agentspace.local.dofe.ai/api/auth/sso/start",
    );
  });

  it("does not expose a local workspace join flow", () => {
    render(<LanguageProvider initialLanguage="zh"><AuthScreen /></LanguageProvider>);
    expect(screen.queryByRole("textbox", { name: /^工作区邀请码/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "使用 Dofe SSO 登录" })).toHaveAttribute("href", "/api/auth/sso/start");
  });

  it("preserves invitation context in the SSO entry path", () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <AuthScreen ssoStartUrl="/api/auth/sso/start?invitationToken=invite-1" invitation={{ token: "invite-1", workspaceName: "Mars Labs", email: "mina@example.com", role: "member" }} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("link", { name: "使用 Dofe SSO 进入工作区" })).toHaveAttribute(
      "href",
      "/api/auth/sso/start?invitationToken=invite-1",
    );
  });
});
