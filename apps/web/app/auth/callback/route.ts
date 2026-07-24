import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createSessionForSsoLogin } from "@/features/auth/server-auth";
import {
  buildSsoCallbackRedirectUrl,
  decodeSsoOidcState,
  exchangeSsoAuthorizationCode,
  SSO_OIDC_STATE_COOKIE,
} from "@/features/auth/sso-oidc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code")?.trim();
  const returnedState = url.searchParams.get("state")?.trim();
  const providerError = url.searchParams.get("error")?.trim();
  const cookieStore = await cookies();
  const state = decodeSsoOidcState(cookieStore.get(SSO_OIDC_STATE_COOKIE)?.value);

  try {
    if (providerError) throw new Error(providerError === "access_denied" ? "auth.sso_access_denied" : "auth.sso_authorization_failed");
    if (!code || !returnedState || !state) throw new Error("auth.sso_state_invalid");
    const result = await exchangeSsoAuthorizationCode({ code, expectedState: state, returnedState });
    await createSessionForSsoLogin({ ...result.profile, idToken: result.idToken });
    const response = NextResponse.redirect(buildSsoCallbackRedirectUrl("/", request.url));
    response.cookies.set(SSO_OIDC_STATE_COOKIE, "", { httpOnly: true, maxAge: 0, path: "/auth/callback", sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    return response;
  } catch (error) {
    const errorCode = error instanceof Error ? error.message : "auth.sso_callback_failed";
    const context = `/auth/error?code=${encodeURIComponent(errorCode)}`;
    const response = NextResponse.redirect(buildSsoCallbackRedirectUrl(context, request.url));
    response.cookies.set(SSO_OIDC_STATE_COOKIE, "", { httpOnly: true, maxAge: 0, path: "/auth/callback", sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    return response;
  }
}
