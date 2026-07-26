import { NextResponse } from "next/server";
import {
  createSsoAuthorizationRequest,
  encodeSsoOidcState,
  OIDC_STATE_TTL_SECONDS,
  SSO_OIDC_STATE_COOKIE,
} from "@/features/auth/sso-oidc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const result = await createSsoAuthorizationRequest();
    const response = NextResponse.redirect(result.authorizationUrl);
    response.cookies.set(SSO_OIDC_STATE_COOKIE, encodeSsoOidcState(result.state), {
      httpOnly: true,
      maxAge: OIDC_STATE_TTL_SECONDS,
      path: "/auth/callback",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
    return response;
  } catch (error) {
    const code = error instanceof Error ? error.message : "auth.sso_start_failed";
    return NextResponse.redirect(new URL(`/auth/error?code=${encodeURIComponent(code)}`, request.url));
  }
}
