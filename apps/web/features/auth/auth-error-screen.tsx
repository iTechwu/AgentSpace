"use client";

import { useLanguage } from "@/features/i18n/language-provider";
import { translateAuthError } from "./auth-error-messages";
import { AuthStatusScreen } from "./auth-status-screen";

export function AuthErrorScreen({ code }: { code?: string }) {
  const { tx } = useLanguage();
  const resolvedCode = code?.trim() || "auth.sso_callback_failed";

  return (
    <AuthStatusScreen
      body={translateAuthError(resolvedCode, tx)}
      eyebrow={tx("身份验证", "Authentication")}
      heroBody={tx(
        "Dofe SSO 是唯一的身份入口。出现错误时，先把问题解释清楚，再回到登录入口。",
        "Dofe SSO is the only identity entry point. When something fails, the UI explains the problem before returning to sign-in.",
      )}
      heroTitle={tx("登录流程被中断了。", "The sign-in flow was interrupted.")}
      highlights={[tx("Dofe SSO", "Dofe SSO")]}
      primaryAction={{
        href: "/",
        label: tx("返回登录页", "Back to sign in"),
      }}
      title={tx("登录失败", "Sign-in failed")}
    />
  );
}
