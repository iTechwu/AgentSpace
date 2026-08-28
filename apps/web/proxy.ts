import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { WORKSPACE_SELECTION_COOKIE } from "@/features/auth/workspace-selection-constants";

export function proxy(request: NextRequest): NextResponse {
  const match = request.nextUrl.pathname.match(/^\/w\/([^/]+)/);
  if (!match?.[1]) {
    return NextResponse.next();
  }

  const response = NextResponse.next();
  response.cookies.set(WORKSPACE_SELECTION_COOKIE, decodeURIComponent(match[1]), {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
  });
  return response;
}

export const config = {
  matcher: ["/w/:path*"],
};
