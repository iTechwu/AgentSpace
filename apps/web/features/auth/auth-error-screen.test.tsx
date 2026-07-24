import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { AuthErrorScreen } from "./auth-error-screen";

describe("AuthErrorScreen", () => {
  it("renders a translated SSO auth error message", () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <AuthErrorScreen code="auth.sso_id_token_invalid" />
      </LanguageProvider>,
    );

    expect(screen.getByText("登录失败")).toBeInTheDocument();
    expect(screen.getByText("Dofe SSO 登录状态校验失败，请重试。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回登录页" })).toHaveAttribute("href", "/");
  });

  it("falls back to a generic auth error code when none is provided", () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <AuthErrorScreen />
      </LanguageProvider>,
    );

    expect(screen.getByText("Dofe SSO 登录失败，请稍后重试。")).toBeInTheDocument();
  });
});
