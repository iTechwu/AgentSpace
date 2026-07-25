"use server";

import { persistWorkspaceAttachmentFromBytesSync } from "@dofe-agent/services";
import type { MessageAttachment } from "@/shared/types/workspace";

type UploadedFile = File & {
  arrayBuffer?: () => Promise<ArrayBuffer>;
  webkitRelativePath?: string;
};

export async function persistFormAttachments(
  formData: FormData,
  key: string,
  workspaceId?: string,
): Promise<MessageAttachment[] | undefined> {
  const files = formData
    .getAll(key)
    .filter((value): value is UploadedFile => isUploadedFile(value) && value.size > 0);

  if (files.length === 0) {
    return undefined;
  }

  return Promise.all(
    files.map(async (file) => {
      const originalName = file.name || "attachment.bin";
      const fileName =
        typeof file.webkitRelativePath === "string" && file.webkitRelativePath.trim().length > 0
          ? file.webkitRelativePath
          : originalName;
      if (typeof file.arrayBuffer !== "function") {
        throw new Error(`Uploaded file "${fileName}" does not expose arrayBuffer().`);
      }

      return persistWorkspaceAttachmentFromBytesSync({
        workspaceId,
        contentBytes: Buffer.from(await file.arrayBuffer()),
        fileName,
        mediaType: file.type,
      });
    }),
  );
}

function isUploadedFile(value: FormDataEntryValue | null): value is UploadedFile {
  if (!value || typeof value === "string") {
    return false;
  }

  return typeof value.size === "number";
}
