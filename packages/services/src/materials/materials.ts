import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { type DofeAgentState, type MaterialInput } from "@dofe-agent/domain/workspace";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";
import { STATE_DIR, slugify, resolveRepositoryRoot } from "../shared/helpers.ts";

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

  if (!existsSync(input.filePath)) {
    throw new Error(`File "${input.filePath}" does not exist.`);
  }

  const materialsDir = join(resolveRepositoryRoot(), STATE_DIR, "materials");
  if (!existsSync(materialsDir)) {
    mkdirSync(materialsDir, { recursive: true });
  }

  const originalName = basename(input.filePath);
  const ext = extname(originalName);
  const base = originalName.slice(0, Math.max(0, originalName.length - ext.length));
  const safeBase = slugify(base);
  const targetName = `${Date.now()}-${safeBase}${ext}`;
  const targetPath = join(materialsDir, targetName);
  copyFileSync(input.filePath, targetPath);

  const fileStat = statSync(targetPath);
  const source = input.label ?? originalName;

  state.materials.unshift({
    id: `mat-${Date.now()}`,
    source,
    status: input.status,
    kind: "file",
    originalPath: input.filePath,
    storedPath: targetPath,
    sizeBytes: fileStat.size,
  });
  state.ledger.unshift({
    title: "File imported",
    note: `Imported file ${source} and stored it as ${targetName} for downstream processing.`,
  });

  return writeWorkspaceStateSync(state);
}

export function parseMaterialSync(id: string): DofeAgentState {
  const state = ensureWorkspaceStateSync();
  const material = state.materials.find((item) => item.id === id);

  if (!material) {
    throw new Error(`Material "${id}" does not exist.`);
  }

  const targetPath = material.storedPath ?? material.originalPath;
  if (!targetPath || !existsSync(targetPath)) {
    throw new Error(`Material "${material.source}" has no readable file source.`);
  }

  const raw = readFileSync(targetPath, "utf8");
  const preview = raw.replace(/\s+/g, " ").trim().slice(0, 220);

  material.preview = preview || "The file is readable, but there is no displayable text to preview.";
  material.status = "parsed";
  state.ledger.unshift({
    title: "Material parsed",
    note: `File ${material.source} completed first-pass parsing and is ready for downstream processing.`,
  });

  return writeWorkspaceStateSync(state);
}
