import { buildHostedInstallScript, resolveRequestOrigin } from "../_lib/distribution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const serverUrl = resolveRequestOrigin(request);
  const script = buildHostedInstallScript(serverUrl);
  return new Response(script, {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
