"use client";

import { useSearchParams } from "next/navigation";
import { AuthErrorScreen } from "./auth-error-screen";

// 静态预渲染配套：错误码从查询参数客户端读取（Next 16 要求 useSearchParams 外包 Suspense）。
export function AuthErrorPageClient() {
  const searchParams = useSearchParams();
  const code = searchParams.get("code") ?? searchParams.get("error") ?? undefined;
  return <AuthErrorScreen code={code} />;
}
