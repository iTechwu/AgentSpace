import { writeFileSync } from "node:fs";
import {
  createWorkspaceSkillSync,
  deleteWorkspaceSkillFileSync,
  deleteWorkspaceSkillSync,
  exportWorkspaceSkillsArchiveSync,
  importWorkspaceSkillFromUrl,
  listWorkspaceSkillsSync,
  readWorkspaceSkillSync,
  updateWorkspaceSkillSync,
  upsertWorkspaceSkillFileSync,
} from "@dofe-agent/services";
import { getStringFlag, parseArgs } from "../lib/args.ts";
import { writeData, type OutputFormat } from "../lib/format.ts";

export async function runSkillCommand(
  subcommand: string | undefined,
  args: string[],
  format: OutputFormat,
): Promise<number> {
  if (subcommand === "list") {
    const { flags } = parseArgs(args);
    writeData(format, listWorkspaceSkillsSync(getStringFlag(flags, "workspace-id") ?? undefined).map(toSkillSummary));
    return 0;
  }

  if (subcommand === "get") {
    const parsed = parseArgs(args);
    const skillId = parsed.positionals[0]?.trim();
    if (!skillId) {
      console.error("Usage: dofe-agent skill get <skill-id> [--workspace-id <id>] [--json]");
      return 1;
    }
    const skill = readWorkspaceSkillSync(skillId, getStringFlag(parsed.flags, "workspace-id") ?? undefined);
    if (!skill) {
      console.error(`Skill "${skillId}" not found.`);
      return 1;
    }
    writeData(format, skill);
    return 0;
  }

  if (subcommand === "create") {
    const { flags } = parseArgs(args);
    const name = getStringFlag(flags, "name")?.trim();
    if (!name) {
      console.error("Usage: dofe-agent skill create --name <name> [--description <text>] [--workspace-id <id>] [--json]");
      return 1;
    }
    const skill = createWorkspaceSkillSync({
      name,
      description: getStringFlag(flags, "description"),
    }, getStringFlag(flags, "workspace-id") ?? undefined);
    writeData(format, skill);
    return 0;
  }

  if (subcommand === "update") {
    const parsed = parseArgs(args);
    const skillId = parsed.positionals[0]?.trim();
    if (!skillId) {
      console.error("Usage: dofe-agent skill update <skill-id> [--name <name>] [--description <text>] [--workspace-id <id>] [--json]");
      return 1;
    }
    const skill = updateWorkspaceSkillSync({
      skillId,
      name: getStringFlag(parsed.flags, "name"),
      description: getStringFlag(parsed.flags, "description"),
    }, getStringFlag(parsed.flags, "workspace-id") ?? undefined);
    writeData(format, skill);
    return 0;
  }

  if (subcommand === "delete") {
    const parsed = parseArgs(args);
    const skillId = parsed.positionals[0]?.trim();
    if (!skillId) {
      console.error("Usage: dofe-agent skill delete <skill-id> [--workspace-id <id>] [--json]");
      return 1;
    }
    deleteWorkspaceSkillSync(skillId, getStringFlag(parsed.flags, "workspace-id") ?? undefined);
    writeData(format, { ok: true, skillId });
    return 0;
  }

  if (subcommand === "export") {
    const parsed = parseArgs(args);
    const workspaceId = getStringFlag(parsed.flags, "workspace-id") ?? undefined;
    const outPath = getStringFlag(parsed.flags, "out")?.trim();
    const skillIds = [
      ...parsed.positionals.map((value) => value.trim()).filter(Boolean),
      ...String(getStringFlag(parsed.flags, "skill-ids") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ];
    if (skillIds.length === 0) {
      console.error("Usage: dofe-agent skill export <skill-id> [more-skill-ids...] [--workspace-id <id>] [--out <zip-path>] [--json]");
      return 1;
    }

    const archive = exportWorkspaceSkillsArchiveSync({
      skillIds,
      workspaceId,
    });
    if (outPath) {
      writeFileSync(outPath, archive.zipBytes);
      writeData(format, {
        ok: true,
        fileName: archive.fileName,
        outPath,
        skillCount: archive.manifest.skillCount,
      });
      return 0;
    }

    writeData(format, {
      fileName: archive.fileName,
      archiveBase64: Buffer.from(archive.zipBytes).toString("base64"),
      manifest: archive.manifest,
    });
    return 0;
  }

  if (subcommand === "files") {
    return runSkillFilesCommand(args, format);
  }

  if (subcommand === "import") {
    const { flags } = parseArgs(args);
    const url = getStringFlag(flags, "url")?.trim();
    if (!url) {
      console.error("Usage: dofe-agent skill import --url <url> [--conflict reject|rename|replace|skip] [--workspace-id <id>] [--json]");
      return 1;
    }
    const conflict = getStringFlag(flags, "conflict") as "reject" | "rename" | "replace" | "skip" | undefined;
    if (conflict && conflict !== "reject" && conflict !== "rename" && conflict !== "replace" && conflict !== "skip") {
      console.error("Invalid --conflict value. Expected reject, rename, replace, or skip.");
      return 1;
    }

    const result = await importWorkspaceSkillFromUrl({
      workspaceId: getStringFlag(flags, "workspace-id") ?? undefined,
      url,
      conflict,
    });
    writeData(format, result);
    return 0;
  }

  console.error("Usage:");
  console.error("  dofe-agent skill list [--workspace-id <id>] [--json]");
  console.error("  dofe-agent skill get <skill-id> [--workspace-id <id>] [--json]");
  console.error("  dofe-agent skill create --name <name> [--description <text>] [--workspace-id <id>] [--json]");
  console.error("  dofe-agent skill update <skill-id> [--name <name>] [--description <text>] [--workspace-id <id>] [--json]");
  console.error("  dofe-agent skill delete <skill-id> [--workspace-id <id>] [--json]");
  console.error("  dofe-agent skill files list <skill-id> [--workspace-id <id>] [--json]");
  console.error("  dofe-agent skill files upsert <skill-id> --path <path> --content <content> [--file-id <id>] [--workspace-id <id>] [--json]");
  console.error("  dofe-agent skill files delete <skill-id> --file-id <id> [--workspace-id <id>] [--json]");
  console.error("  dofe-agent skill import --url <url> [--conflict reject|rename|replace|skip] [--workspace-id <id>] [--json]");
  console.error("  dofe-agent skill export <skill-id> [more-skill-ids...] [--workspace-id <id>] [--out <zip-path>] [--json]");
  return 1;
}

function runSkillFilesCommand(args: string[], format: OutputFormat): number {
  const parsed = parseArgs(args);
  const action = parsed.positionals[0];
  const skillId = parsed.positionals[1]?.trim();
  const workspaceId = getStringFlag(parsed.flags, "workspace-id") ?? undefined;

  if (action === "list") {
    if (!skillId) {
      console.error("Usage: dofe-agent skill files list <skill-id> [--workspace-id <id>] [--json]");
      return 1;
    }
    const skill = readWorkspaceSkillSync(skillId, workspaceId);
    if (!skill) {
      console.error(`Skill "${skillId}" not found.`);
      return 1;
    }
    writeData(format, skill.files);
    return 0;
  }

  if (action === "upsert") {
    if (!skillId) {
      console.error("Usage: dofe-agent skill files upsert <skill-id> --path <path> --content <content> [--file-id <id>] [--workspace-id <id>] [--json]");
      return 1;
    }
    const path = getStringFlag(parsed.flags, "path")?.trim();
    const content = getStringFlag(parsed.flags, "content");
    if (!path || content === undefined) {
      console.error("Both --path and --content are required.");
      return 1;
    }

    const file = upsertWorkspaceSkillFileSync({
      skillId,
      fileId: getStringFlag(parsed.flags, "file-id")?.trim() || undefined,
      path,
      content,
    }, workspaceId);
    writeData(format, file);
    return 0;
  }

  if (action === "delete") {
    if (!skillId) {
      console.error("Usage: dofe-agent skill files delete <skill-id> --file-id <id> [--workspace-id <id>] [--json]");
      return 1;
    }
    const fileId = getStringFlag(parsed.flags, "file-id")?.trim();
    if (!fileId) {
      console.error("--file-id is required.");
      return 1;
    }
    deleteWorkspaceSkillFileSync(skillId, fileId, workspaceId);
    writeData(format, { ok: true, skillId, fileId });
    return 0;
  }

  console.error("Usage:");
  console.error("  dofe-agent skill files list <skill-id> [--workspace-id <id>] [--json]");
  console.error("  dofe-agent skill files upsert <skill-id> --path <path> --content <content> [--file-id <id>] [--workspace-id <id>] [--json]");
  console.error("  dofe-agent skill files delete <skill-id> --file-id <id> [--workspace-id <id>] [--json]");
  return 1;
}

function toSkillSummary(skill: NonNullable<ReturnType<typeof listWorkspaceSkillsSync>[number]>) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    sourceType: skill.sourceType ?? "manual",
    sourceUrl: skill.sourceUrl ?? "",
    fileCount: skill.files.length,
    updatedAt: skill.updatedAt,
  };
}
