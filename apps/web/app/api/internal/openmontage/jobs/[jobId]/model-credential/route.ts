import {
  issueOpenMontageModelCredential,
  OpenMontageDelegationAuthenticationError,
  OpenMontageDelegationConfigurationError,
} from "@dofe-agent/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  let body: { stage?: unknown };
  try {
    body = (await request.json()) as { stage?: unknown };
  } catch {
    return Response.json({ error: { code: "OPENMONTAGE_MODEL_CREDENTIAL_INVALID" } }, { status: 422 });
  }
  const stage = typeof body.stage === "string" ? body.stage.trim() : "";
  if (!stage || stage.length > 128) {
    return Response.json({ error: { code: "OPENMONTAGE_MODEL_CREDENTIAL_INVALID" } }, { status: 422 });
  }
  const { jobId } = await context.params;
  try {
    const credential = issueOpenMontageModelCredential({
      jobId,
      stage,
      headers: request.headers,
    });
    return Response.json(credential, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        Pragma: "no-cache",
      },
    });
  } catch (error) {
    if (error instanceof OpenMontageDelegationAuthenticationError) {
      return Response.json(
        { error: { code: "OPENMONTAGE_MODEL_CREDENTIAL_UNAUTHORIZED" } },
        { status: 401, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    if (error instanceof OpenMontageDelegationConfigurationError) {
      return Response.json(
        { error: { code: "OPENMONTAGE_MODEL_CREDENTIAL_UNAVAILABLE" } },
        { status: 503, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    throw error;
  }
}
