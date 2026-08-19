import type { Metadata } from "next";
import type { ReactNode } from "react";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { FeedbackToastProvider } from "@/shared/ui/feedback-toast-provider";
import "@xyflow/react/dist/style.css";
import "./globals.css";

const configuredLanguage = process.env.DOFE_AGENT_UI_LANGUAGE;
const initialLanguage = configuredLanguage === "en" || configuredLanguage === "zh" ? configuredLanguage : "zh";

export const metadata: Metadata = {
  title: {
    default: "Sign in to DoFe.AI",
    template: "%s | DoFe.AI",
  },
  description:
    "DoFe.AI is an execution engine for employees, enterprises, and empowerment.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang={initialLanguage === "zh" ? "zh-CN" : "en"} suppressHydrationWarning>
      <body>
        <LanguageProvider initialLanguage={initialLanguage}>
          <FeedbackToastProvider>{children}</FeedbackToastProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
