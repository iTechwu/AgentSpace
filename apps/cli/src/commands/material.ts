import {
  addMaterialSync,
  importMaterialFileSync,
  listMaterialsSync,
  parseMaterialSync,
} from "@dofe-agent/services";
import { parseArgs, getStringFlag } from "../lib/args.ts";
import { writeData, type OutputFormat } from "../lib/format.ts";

export function runMaterialCommand(
  subcommand: string | undefined,
  args: string[],
  format: OutputFormat,
): number {
  if (subcommand === "list") {
    writeData(format, listMaterialsSync());
    return 0;
  }

  if (subcommand === "add") {
    const { flags } = parseArgs(args);
    const source = getStringFlag(flags, "source");
    const status = getStringFlag(flags, "status") ?? "待处理";

    if (!source) {
      console.error('Usage: dofe-agent material add --source <source> [--status <status>] [--json]');
      return 1;
    }

    const state = addMaterialSync(source, status);
    writeData(format, {
      ok: true,
      source,
      status,
      totalMaterials: state.materials.length,
    });
    return 0;
  }

  if (subcommand === "import-file") {
    const { flags } = parseArgs(args);
    const filePath = getStringFlag(flags, "path");
    const label = getStringFlag(flags, "label");
    const status = getStringFlag(flags, "status") ?? "已导入文件";

    if (!filePath) {
      console.error(
        'Usage: dofe-agent material import-file --path <file-path> [--label <name>] [--status <status>] [--json]',
      );
      return 1;
    }

    const state = importMaterialFileSync({
      filePath,
      label,
      status,
    });

    writeData(format, {
      ok: true,
      filePath,
      label: label ?? null,
      status,
      totalMaterials: state.materials.length,
    });
    return 0;
  }

  if (subcommand === "parse") {
    const { flags } = parseArgs(args);
    const id = getStringFlag(flags, "id");

    if (!id) {
      console.error('Usage: dofe-agent material parse --id <material-id> [--json]');
      return 1;
    }

    const state = parseMaterialSync(id);
    const material = state.materials.find((item: (typeof state.materials)[number]) => item.id === id);
    writeData(format, {
      ok: true,
      id,
      source: material?.source ?? null,
      status: material?.status ?? null,
      preview: material?.preview ?? null,
    });
    return 0;
  }

  if (subcommand === "generate") {
    console.error("material generate 已移除；当前请使用群文档、skills 或 agent 创建流程。");
    return 1;
  }

  console.error("Usage: dofe-agent material list [--json]");
  console.error("   or: dofe-agent material add --source <source> [--status <status>] [--json]");
  console.error(
    "   or: dofe-agent material import-file --path <file-path> [--label <name>] [--status <status>] [--json]",
  );
  console.error("   or: dofe-agent material parse --id <material-id> [--json]");
  console.error("   or: dofe-agent material generate --id <material-id> [--json]");
  return 1;
}
