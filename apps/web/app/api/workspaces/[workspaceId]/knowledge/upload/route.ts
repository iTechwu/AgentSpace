import { submitFileParseTaskSync, type FileParseIntent } from "@dofe-agent/services";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/workspaces/:workspaceId/knowledge/upload
 *
 * 上传一个文件（PDF / DOCX / PPTX / XLSX / Markdown / TXT）并启动解析任务。
 * 浏览器以 multipart/form-data 提交：
 *   - `file`  (File, 必填)
 *   - `intent` ("auto_deposit" | "document_only", 必填)
 *
 * 返回：
 *   - 201 { capabilityRequestId, attachmentId, status: "running" }
 *
 * 解析是 fire-and-forget：API 立即返回，客户端通过 GET /capability-requests
 * 轮询状态。解析成功后会落 knowledge_page，并写入 capability_request.linked_knowledge_page_id；
 * `auto_deposit` 会自动创建知识页，`document_only` 仅入文档页。
 */
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB

function isFileParseIntent(value: unknown): value is FileParseIntent {
  return value === "auto_deposit" || value === "document_only";
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { workspaceId } = await context.params;
  if (workspaceId !== workspaceContext.currentWorkspace.id) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }
  if (!workspaceContext.currentUser) {
    return Response.json({ error: "Session is missing user identity." }, { status: 401 });
  }
  assertWorkspaceRoleForContext(workspaceContext, "admin");

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Body must be multipart/form-data." }, { status: 400 });
  }

  const file = formData.get("file");
  const intent = formData.get("intent");
  if (!(file instanceof File)) {
    return Response.json({ error: "Field `file` is required." }, { status: 400 });
  }
  if (!isFileParseIntent(intent)) {
    return Response.json({ error: "Field `intent` must be one of auto_deposit | document_only." }, { status: 400 });
  }
  if (file.size <= 0) {
    return Response.json({ error: "Uploaded file is empty." }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return Response.json({ error: `File too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB).` }, { status: 413 });
  }

  try {
    const contentBytes = new Uint8Array(await file.arrayBuffer());
    const result = submitFileParseTaskSync({
      workspaceId,
      requestedByUserId: workspaceContext.currentUser.id,
      requestedByDisplayName: workspaceContext.currentUser.displayName ?? "unknown",
      contentBytes,
      fileName: file.name || "upload",
      mediaType: file.type || undefined,
      intent,
    });
    return Response.json(
      {
        capabilityRequestId: result.capabilityRequestId,
        attachmentId: result.attachmentId,
        status: result.status,
      },
      { status: 201, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    return Response.json({ error: message }, { status: 400 });
  }
}
