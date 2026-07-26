import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { AuthScreen } from "./auth-screen";

describe("AuthScreen", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("uses the server-provided SSO start URL", () => {
    render(<LanguageProvider><AuthScreen ssoStartUrl="https://dofe-agent.local.dofe.ai/api/auth/sso/start" /></LanguageProvider>);
    expect(screen.getByRole("link", { name: "Continue with Dofe SSO" })).toHaveAttribute(
      "href",
      "https://dofe-agent.local.dofe.ai/api/auth/sso/start",
    );
  });

  it("does not expose a local workspace join flow", () => {
    render(<LanguageProvider initialLanguage="zh"><AuthScreen /></LanguageProvider>);
    expect(screen.queryByRole("textbox", { name: /^工作区邀请码/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "使用 Dofe SSO 登录" })).toHaveAttribute("href", "/api/auth/sso/start");
  });

  it("presents agent.dofe and the Do For E brand promise", () => {
    render(<LanguageProvider initialLanguage="zh"><AuthScreen /></LanguageProvider>);

    expect(screen.getByRole("heading", { level: 1, name: "agent.dofe" })).toBeInTheDocument();
    expect(document.querySelector(".public-hero__statement")).toHaveTextContent("人类与数字员工，共用一个工作空间。");
    expect(screen.getByText("Do For Employee · Do For Enterprise · Do For Empowerment", { selector: ".public-brand-story__tagline" })).toBeInTheDocument();
    expect(screen.getByText("成为受世界尊敬的中国企业")).toBeInTheDocument();
    expect(screen.getByText("成就中国智造的全球竞争力")).toBeInTheDocument();
  });

  it("keeps primary landing actions connected to real destinations", () => {
    render(<LanguageProvider initialLanguage="zh"><AuthScreen ssoStartUrl="/api/auth/sso/start?next=workspace" /></LanguageProvider>);

    expect(screen.getByRole("link", { name: "登录" })).toHaveAttribute("href", "/api/auth/sso/start?next=workspace");
    expect(screen.getByRole("link", { name: "进入工作区" })).toHaveAttribute("href", "/api/auth/sso/start?next=workspace");
    expect(screen.getByRole("link", { name: "查看真实产品" })).toHaveAttribute("href", "#product");
  });

  it("responds when the user switches the real product tour", () => {
    render(<LanguageProvider initialLanguage="zh"><AuthScreen /></LanguageProvider>);

    expect(screen.getByRole("heading", { level: 3, name: "从一句话开始，把工作交给正确的人或 Agent。" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "02数字员工" }));
    expect(screen.getByRole("heading", { level: 3, name: "把 Agent 当作组织能力管理，而不是散落的工具。" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "数字员工展板页面截图" })).toHaveAttribute("src", expect.stringContaining("employee-showcase.png"));
  });
});
