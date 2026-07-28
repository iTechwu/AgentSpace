import { type DofeAgentState, type MaterialInput } from "@dofe-agent/domain/workspace";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";
import {
  persistWorkspaceAttachmentFromFileSync,
  readWorkspaceAttachmentBytesSync,
} from "../attachments/attachments.ts";

export function listMaterialsSync(): MaterialInput[] {
  return ensureWorkspaceStateSync().materials;
}

export function addMaterialSync(source: string, status: string): DofeAgentState {
  const state = ensureWorkspaceStateSync();
  state.materials.unshift({
    id: `mat-${Date.now()}`,
    source,
    status,
    kind: "note",
  });
  state.ledger.unshift({
    title: "Material added",
    note: `Added material source ${source} with status ${status}.`,
  });

  return writeWorkspaceStateSync(state);
}

export function importMaterialFileSync(input: {
  filePath: string;
  label?: string;
  status: string;
}): DofeAgentState {
  const state = ensureWorkspaceStateSync();
  const attachment = persistWorkspaceAttachmentFromFileSync({
    sourcePath: input.filePath,
  });
  const source = input.label ?? attachment.fileName;

  state.materials.unshift({
    id: attachment.id,
    source,
    status: input.status,
    kind: "file",
    fileName: attachment.fileName,
    mediaType: attachment.mediaType,
    storedPath: attachment.storedPath,
    storageProvider: attachment.storageProvider,
    storageBucket: attachment.storageBucket,
    storageRegion: attachment.storageRegion,
    storageEndpoint: attachment.storageEndpoint,
    storageKey: attachment.storageKey,
    storageUrl: attachment.storageUrl,
    sha256: attachment.sha256,
    sizeBytes: attachment.sizeBytes,
  });
  state.ledger.unshift({
    title: "File imported",
    note: `Imported file ${source} into TOS for downstream processing.`,
  });

  return writeWorkspaceStateSync(state);
}

export function parseMaterialSync(id: string): DofeAgentState {
  const state = ensureWorkspaceStateSync();
  const material = state.materials.find((item) => item.id === id);

  if (!material) {
    throw new Error(`Material "${id}" does not exist.`);
  }

  if (!material.storedPath || !material.storageKey) {
    throw new Error(`Material "${material.source}" has no readable TOS object.`);
  }

  const raw = Buffer.from(readWorkspaceAttachmentBytesSync({
    storedPath: material.storedPath,
    storageBucket: material.storageBucket,
    storageRegion: material.storageRegion,
    storageEndpoint: material.storageEndpoint,
    storageKey: material.storageKey,
  })).toString("utf8");
  const preview = raw.replace(/\s+/g, " ").trim().slice(0, 220);

  material.preview = preview || "The file is readable, but there is no displayable text to preview.";
  material.status = "parsed";
  state.ledger.unshift({
    title: "Material parsed",
    note: `File ${material.source} completed first-pass parsing and is ready for downstream processing.`,
  });

  return writeWorkspaceStateSync(state);
}
