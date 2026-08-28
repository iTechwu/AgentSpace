import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { FeedbackToastProvider } from "@/shared/ui/feedback-toast-provider";
import { readPublicAppUrl } from "@/features/auth/public-app-url";
import "@xyflow/react/dist/style.css";
import "./globals.css";

const configuredLanguage = process.env.DOFE_AGENT_UI_LANGUAGE;
const initialLanguage = configuredLanguage === "en" || configuredLanguage === "zh" ? configuredLanguage : "zh";

const APP_DESCRIPTION =
  "DoFe.AI（Do For E）是面向员工、企业与赋能场景的 AI 执行引擎：一句话启动一切，让数字员工替你执行任务、编排流程、管理知识。";

export const metadata: Metadata = {
  title: {
    default: "DoFe.AI — 一句话启动一切的 AI 执行引擎",
    template: "%s | DoFe.AI",
  },
  description: APP_DESCRIPTION,
  applicationName: "DoFe.AI",
  keywords: [
    "DoFe.AI",
    "Do For E",
    "AI 执行引擎",
    "数字员工",
    "AI Employee",
    "智能体",
    "企业智能体平台",
    "工作流编排",
    "知识库",
    "任务看板",
    "MCP",
  ],
  openGraph: {
    type: "website",
    siteName: "DoFe.AI",
    title: "DoFe.AI — 一句话启动一切的 AI 执行引擎",
    description: APP_DESCRIPTION,
  },
  ...(readPublicAppUrl() ? { metadataBase: new URL(readPublicAppUrl()!) } : {}),
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang={initialLanguage === "zh" ? "zh-CN" : "en"} suppressHydrationWarning>
      <body className={GeistSans.variable}>
        <LanguageProvider initialLanguage={initialLanguage}>
          <FeedbackToastProvider>{children}</FeedbackToastProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
