import { Suspense } from "react";
import { AuthErrorScreen } from "@/features/auth/auth-error-screen";
import { AuthErrorPageClient } from "@/features/auth/auth-error-page-client";

// 静态预渲染（P2「零 SSG」项）：SSO 失败场景的错误页不依赖服务器渲染健康度，
// code/error 查询参数由客户端读取；fallback 直接给无码错误壳，避免闪空。
export default function AuthErrorPage() {
  return (
    <Suspense fallback={<AuthErrorScreen code={undefined} />}>
      <AuthErrorPageClient />
    </Suspense>
  );
}
