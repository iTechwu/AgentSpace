import { buildDaemonPackageTarball } from "../_lib/distribution";
import { requireDaemonAuth } from "../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const { fileName, content } = buildDaemonPackageTarball();
  return new Response(new Uint8Array(content), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "no-store",
    },
  });
}
