import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthErrorScreen } from "@/features/auth/auth-error-screen";
import { AuthErrorPageClient } from "@/features/auth/auth-error-page-client";

export const metadata: Metadata = {
  title: "登录遇到问题",
  description: "DoFe.AI 登录失败说明页：查看登录失败的原因与可采取的处理方式。",
};

// 静态预渲染（P2「零 SSG」项）：SSO 失败场景的错误页不依赖服务器渲染健康度，
// code/error 查询参数由客户端读取；fallback 直接给无码错误壳，避免闪空。
export default function AuthErrorPage() {
  return (
    <Suspense fallback={<AuthErrorScreen code={undefined} />}>
      <AuthErrorPageClient />
    </Suspense>
  );
}
