import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  appendAgentOutputAttachment,
  appendChannelDocumentManifestEntry,
  appendDocumentPermissionRequest,
  appendKnowledgeProposalManifestEntry,
  appendSkillImportManifestEntry,
  createRuntimeOutputPreview,
  prepareRuntimeOutputArtifactReference,
  readSkillImportsManifest,
  setAgentOutputText,
  validateRuntimeOutputManifests,
  type ChannelDocumentManifestEntry,
  type ChannelDocumentManifestOperation,
  type DocumentPermissionRequestManifestEntry,
  type KnowledgeProposalManifestEntry,
  type SkillImportManifestEntry,
} from "../../../../packages/daemon/src/runtime-output-manifests.ts";
import {
  appendFeishuRuntimeDataOperationRequest,
  type FeishuRuntimeDataOperationRequestManifestEntry,
} from "@dofe-agent/services";
import { prepareSkillImportOperationArtifacts } from "../../../../packages/daemon/src/skill-imports.ts";
import { getStringFlag, parseArgs } from "../lib/args.ts";
import { writeData, type OutputFormat } from "../lib/format.ts";
import { RUNTIME_OUTPUT_ARTIFACTS_RELATIVE_DIR } from "../lib/runtime-output.ts";

type OutputConflict = "reject" | "rename" | "replace" | "skip";

export async function runOutputCommand(
  subcommand: string | undefined,
  args: string[],
  format: OutputFormat,
): Promise<number> {
  try {
    if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
      printOutputHelp();
      return subcommand ? 0 : 1;
    }
    if (subcommand === "attach") {
      return runAttach(args, format);
    }
    if (subcommand === "text") {
      return runText(args, format);
    }
    if (subcommand === "validate") {
      if (hasHelpFlag(args)) {
        printOutputHelp();
        return 0;
      }
      return runValidate(args, format);
    }
    if (subcommand === "preview") {
      return runPreview(args, format);
    }
    if (subcommand === "document") {
      return runDocumentCommand(args, format);
    }
    if (subcommand === "skill") {
      return runSkillCommand(args, format);
    }
    if (subcommand === "knowledge") {
      return runKnowledgeCommand(args, format);
    }
    if (subcommand === "feishu") {
      return runFeishuCommand(args, format);
    }
    if (subcommand === "permission") {
      return runPermissionCommand(args, format);
    }
    printOutputHelp();
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function runAttach(args: string[], format: OutputFormat): number {
  const parsed = parseArgs(args);
  const workDir = resolveWorkDir(parsed.flags);
  const sourcePath = parsed.positionals[0];
  if (!sourcePath) {
    throw new Error("Usage: dofe-agent output attach <file> [--name <display-name>] [--media-type <mime>] [--text <message>] [--copy] [--work-dir <path>]");
  }

  const prepared = prepareRuntimeOutputArtifactReference({
    workDir,
    sourcePath,
    copyOutsideWorkDir: parsed.flags.copy === true,
  });
  const manifest = appendAgentOutputAttachment(
    workDir,
    {
      path: prepared.relativePath,
      name: getStringFlag(parsed.flags, "name") ?? basename(prepared.relativePath),
      mediaType: getStringFlag(parsed.flags, "media-type"),
    },
    getStringFlag(parsed.flags, "text"),
  );

  if (format === "json") {
    writeData(format, manifest);
  } else {
    console.log(`Attached ${prepared.relativePath}${prepared.copied ? " (copied)" : ""}.`);
  }
  return 0;
}

function runText(args: string[], format: OutputFormat): number {
  const parsed = parseArgs(args);
  const workDir = resolveWorkDir(parsed.flags);
  const text = parsed.positionals.join(" ").trim();
  if (!text) {
    throw new Error("Usage: dofe-agent output text <message> [--work-dir <path>]");
  }

  const manifest = setAgentOutputText(workDir, text);
  if (format === "json") {
    writeData(format, manifest);
  } else {
    console.log("Updated runtime-output/agent-output.json text.");
  }
  return 0;
}

function runValidate(args: string[], format: OutputFormat): number {
  const parsed = parseArgs(args);
  const workDir = resolveWorkDir(parsed.flags);
  const result = validateRuntimeOutputManifests(workDir);
  if (format === "json") {
    writeData(format, result);
  } else if (result.valid) {
    console.log("runtime-output manifests are valid.");
  } else {
    for (const error of result.errors) {
      console.error(error);
    }
  }
  return result.valid ? 0 : 1;
}

function runPreview(args: string[], format: OutputFormat): number {
  const parsed = parseArgs(args);
  const workDir = resolveWorkDir(parsed.flags);
  const preview = createRuntimeOutputPreview(workDir);
  if (format === "json") {
    writeData(format, preview);
  } else {
    printPreview(preview);
  }
  return preview.errors.length === 0 ? 0 : 1;
}

function runDocumentCommand(args: string[], format: OutputFormat): number {
  const [action, ...rest] = args;
  if (!action || action === "help" || action === "--help") {
    printDocumentHelp();
    return action ? 0 : 1;
  }
  if (action === "upsert") {
    return runDocumentUpsert(rest, format);
  }
  if (action === "replace-block") {
    return runDocumentBlockOperation(rest, format, "replace_block");
  }
  if (action === "insert-after") {
    return runDocumentBlockOperation(rest, format, "insert_after");
  }
  if (action === "delete-block") {
    return runDocumentBlockOperation(rest, format, "delete_block");
  }
  printDocumentHelp();
  return 1;
}

function runDocumentUpsert(args: string[], format: OutputFormat): number {
  const parsed = parseArgs(args);
  const workDir = resolveWorkDir(parsed.flags);
  const title = requireStringFlag(parsed.flags, "title");
  const content = requireStringFlag(parsed.flags, "content");
  const mode = normalizeDocumentMode(getStringFlag(parsed.flags, "mode"));
  const prepared = prepareRuntimeOutputArtifactReference({
    workDir,
    sourcePath: content,
  });
  const manifest = appendChannelDocumentManifestEntry(workDir, {
    title,
    contentPath: prepared.relativePath,
    documentId: getStringFlag(parsed.flags, "document-id"),
    baseVersionId: getStringFlag(parsed.flags, "base-version-id"),
    summary: getStringFlag(parsed.flags, "summary"),
    mode,
  });
  writeCommandResult(format, manifest, `Added document upsert for "${title}".`);
  return 0;
}

function runDocumentBlockOperation(
  args: string[],
  format: OutputFormat,
  op: ChannelDocumentManifestOperation["op"],
): number {
  const parsed = parseArgs(args);
  const workDir = resolveWorkDir(parsed.flags);
  const title = requireStringFlag(parsed.flags, "title");
  const documentId = requireStringFlag(parsed.flags, "document-id");
  const baseVersionId = requireStringFlag(parsed.flags, "base-version-id");
  const operation = buildDocumentBlockOperation(workDir, parsed.flags, op);
  const entry: ChannelDocumentManifestEntry = {
    title,
    documentId,
    baseVersionId,
    mode: "create_or_update",
    operations: [operation],
  };
  const summary = getStringFlag(parsed.flags, "summary");
  if (summary) {
    entry.summary = summary;
  }
  const manifest = appendChannelDocumentManifestEntry(workDir, entry);
  writeCommandResult(format, manifest, `Added ${op} operation for "${title}".`);
  return 0;
}

function buildDocumentBlockOperation(
  workDir: string,
  flags: Record<string, string | boolean>,
  op: ChannelDocumentManifestOperation["op"],
): ChannelDocumentManifestOperation {
  if (op === "delete_block") {
    return {
      op,
      blockId: requireStringFlag(flags, "block-id"),
      baseRevision: requireNumberFlag(flags, "base-revision"),
    };
  }

  const prepared = prepareRuntimeOutputArtifactReference({
    workDir,
    sourcePath: requireStringFlag(flags, "content"),
  });
  const operation: ChannelDocumentManifestOperation = {
    op,
    contentPath: prepared.relativePath,
    heading: getStringFlag(flags, "heading"),
  };
  if (op === "replace_block") {
    operation.blockId = requireStringFlag(flags, "block-id");
    operation.baseRevision = requireNumberFlag(flags, "base-revision");
  }
  if (op === "insert_after") {
    operation.afterBlockId = getStringFlag(flags, "after-block-id");
  }
  return operation;
}

function runSkillCommand(args: string[], format: OutputFormat): number {
  const [action, ...rest] = args;
  if (!action || action === "help" || action === "--help") {
    printSkillHelp();
    return action ? 0 : 1;
  }
  if (action !== "import") {
    printSkillHelp();
    return 1;
  }
  const parsed = parseArgs(rest);
  const workDir = resolveWorkDir(parsed.flags);
  const entry = buildSkillImportEntry(workDir, parsed.flags);
  appendSkillImportManifestEntry(workDir, entry);

  if (getStringFlag(parsed.flags, "local-path")) {
    const prepared = prepareSkillImportOperationArtifacts(workDir);
    const validation = validateRuntimeOutputManifests(workDir);
    if (!validation.valid) {
      throw new Error(validation.errors.join("\n"));
    }
    for (const warning of prepared.warnings) {
      console.error(warning);
    }
  }

  const manifest = readSkillImportsManifest(workDir);
  writeCommandResult(format, manifest, "Added skill import operation.");
  return 0;
}

function buildSkillImportEntry(
  workDir: string,
  flags: Record<string, string | boolean>,
): SkillImportManifestEntry {
  const url = getStringFlag(flags, "url");
  const path = getStringFlag(flags, "path");
  const localPath = getStringFlag(flags, "local-path");
  const sources = [url ? "url" : "", path ? "path" : "", localPath ? "local-path" : ""].filter(Boolean);
  if (sources.length !== 1) {
    throw new Error("skill import requires exactly one of --url, --path, or --local-path.");
  }

  const entry: SkillImportManifestEntry = {
    conflict: normalizeConflict(getStringFlag(flags, "conflict")),
    assignToSelf: parseBooleanFlag(flags, "assign-to-self", true),
  };
  if (url) {
    assertSkillImportUrl(url);
    entry.url = url;
  } else if (path) {
    entry.path = normalizeRuntimeArtifactPath(workDir, path);
  } else if (localPath) {
    entry.path = localPath;
  }
  return entry;
}

function runKnowledgeCommand(args: string[], format: OutputFormat): number {
  const [action, ...rest] = args;
  if (!action || action === "help" || action === "--help") {
    printKnowledgeHelp();
    return action ? 0 : 1;
  }
  if (action !== "propose-create" && action !== "propose-update") {
    printKnowledgeHelp();
    return 1;
  }
  const parsed = parseArgs(rest);
  const workDir = resolveWorkDir(parsed.flags);
  const proposal = buildKnowledgeProposal(workDir, action, parsed.flags);
  const manifest = appendKnowledgeProposalManifestEntry(workDir, proposal);
  writeCommandResult(format, manifest, `Added knowledge ${action} proposal for "${proposal.title}".`);
  return 0;
}

function buildKnowledgeProposal(
  workDir: string,
  action: "propose-create" | "propose-update",
  flags: Record<string, string | boolean>,
): KnowledgeProposalManifestEntry {
  const contentFile = requireStringFlag(flags, "content-file");
  const prepared = prepareRuntimeOutputArtifactReference({
    workDir,
    sourcePath: contentFile,
    copyOutsideWorkDir: true,
  });
  if (!prepared.relativePath.toLocaleLowerCase("en-US").endsWith(".md")) {
    throw new Error("--content-file must point to a Markdown .md file.");
  }
  const assignmentMode = normalizeKnowledgeAssignmentMode(getStringFlag(flags, "assignment-mode"));
  const assignedEmployeeNames = parseCommaSeparatedFlag(getStringFlag(flags, "assigned-employee-names"));
  const tags = parseCommaSeparatedFlag(getStringFlag(flags, "tags"));
  const entry = removeUndefinedProperties({
    operation: action === "propose-create" ? "create" as const : "update" as const,
    title: requireStringFlag(flags, "title"),
    contentPath: prepared.relativePath,
    summary: getStringFlag(flags, "summary")?.trim(),
    reason: getStringFlag(flags, "reason")?.trim(),
    tags: tags.length > 0 ? tags : undefined,
    parentId: getStringFlag(flags, "parent-id")?.trim(),
    assignmentMode,
    assignedEmployeeNames: assignedEmployeeNames.length > 0 ? assignedEmployeeNames : undefined,
    assignToSelf: parseBooleanFlag(flags, "assign-to-self", true),
    targetKnowledgePageId: getStringFlag(flags, "knowledge-page-id")?.trim(),
    baseUpdatedAt: getStringFlag(flags, "base-updated-at")?.trim(),
  }) as KnowledgeProposalManifestEntry;
  if (entry.operation === "update") {
    if (!entry.targetKnowledgePageId) {
      throw new Error("propose-update requires --knowledge-page-id.");
    }
    if (!entry.baseUpdatedAt) {
      throw new Error("propose-update requires --base-updated-at.");
    }
  }
  return entry;
}

function normalizeKnowledgeAssignmentMode(value: string | undefined): KnowledgeProposalManifestEntry["assignmentMode"] {
  if (!value) {
    return "selected_agents";
  }
  if (value === "all_agents" || value === "selected_agents") {
    return value;
  }
  throw new Error("--assignment-mode must be all_agents or selected_agents.");
}

function assertSkillImportUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--url must be a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("--url must use HTTPS.");
  }
  const allowedHosts = new Set(["github.com", "raw.githubusercontent.com", "skills.sh", "clawhub.ai"]);
  const hostname = parsed.hostname.toLowerCase();
  if (!allowedHosts.has(hostname) && !hostname.endsWith(".clawhub.ai")) {
    throw new Error("--url host must be GitHub, skills.sh, or ClawHub.");
  }
}

function runFeishuCommand(args: string[], format: OutputFormat): number {
  const [action, ...rest] = args;
  if (!action || action === "help" || action === "--help") {
    printFeishuOutputHelp();
    return action ? 0 : 1;
  }
  if (action !== "data-operation-approval") {
    printFeishuOutputHelp();
    return 1;
  }
  const parsed = parseArgs(rest);
  const workDir = resolveWorkDir(parsed.flags);
  const request = buildFeishuRuntimeDataOperationRequest(parsed.flags);
  const manifest = appendFeishuRuntimeDataOperationRequest(workDir, request);
  writeCommandResult(format, manifest, `Added Feishu ${request.operationType} approval request.`);
  return 0;
}

function buildFeishuRuntimeDataOperationRequest(
  flags: Record<string, string | boolean>,
): FeishuRuntimeDataOperationRequestManifestEntry {
  const parameters = buildFeishuRuntimeDataOperationParameters(flags);
  return removeUndefinedProperties({
    operationType: requireStringFlag(flags, "operation"),
    providerResourceType: requireStringFlag(flags, "type"),
    providerResourceToken: requireStringFlag(flags, "resource"),
    parameters,
    contentPreview: getStringFlag(flags, "preview")?.trim(),
  }) as FeishuRuntimeDataOperationRequestManifestEntry;
}

function buildFeishuRuntimeDataOperationParameters(
  flags: Record<string, string | boolean>,
): Record<string, unknown> | undefined {
  const parametersJson = getStringFlag(flags, "parameters-json");
  const parameters = parametersJson
    ? parseJsonObjectFlag(parametersJson, "--parameters-json")
    : {};
  const valuesJson = getStringFlag(flags, "values-json");
  const fieldsJson = getStringFlag(flags, "fields-json");
  const recordsJson = getStringFlag(flags, "records-json");
  const blocksJson = getStringFlag(flags, "blocks-json");
  const childrenJson = getStringFlag(flags, "children-json");
  const blockJson = getStringFlag(flags, "block-json");
  const additions: Record<string, unknown> = {
    mutation: getStringFlag(flags, "mutation")?.trim(),
    action: getStringFlag(flags, "action")?.trim(),
    range: getStringFlag(flags, "range")?.trim(),
    values: valuesJson ? parseJsonFlagValue(valuesJson, "--values-json") : undefined,
    recordId: getStringFlag(flags, "record-id")?.trim(),
    fields: fieldsJson ? parseJsonObjectFlag(fieldsJson, "--fields-json") : undefined,
    records: recordsJson ? parseJsonFlagValue(recordsJson, "--records-json") : undefined,
    title: getStringFlag(flags, "title")?.trim(),
    folderToken: getStringFlag(flags, "folder-token")?.trim(),
    parentBlockId: getStringFlag(flags, "parent-block-id")?.trim(),
    blockId: getStringFlag(flags, "block-id")?.trim(),
    documentRevisionId: getStringFlag(flags, "document-revision-id")?.trim(),
    clientToken: getStringFlag(flags, "client-token")?.trim(),
    blocks: blocksJson ? parseJsonFlagValue(blocksJson, "--blocks-json") : undefined,
    children: childrenJson ? parseJsonFlagValue(childrenJson, "--children-json") : undefined,
    block: blockJson ? parseJsonObjectFlag(blockJson, "--block-json") : undefined,
  };
  for (const [key, value] of Object.entries(additions)) {
    if (value !== undefined && value !== "") {
      parameters[key] = value;
    }
  }
  return Object.keys(parameters).length > 0 ? parameters : undefined;
}

function runPermissionCommand(args: string[], format: OutputFormat): number {
  const [action, ...rest] = args;
  if (!action || action === "help" || action === "--help") {
    printPermissionHelp();
    return action ? 0 : 1;
  }
  if (action !== "request-document") {
    printPermissionHelp();
    return 1;
  }
  const parsed = parseArgs(rest);
  const workDir = resolveWorkDir(parsed.flags);
  const request = buildDocumentPermissionRequest(parsed.flags);
  const manifest = appendDocumentPermissionRequest(workDir, request);
  writeCommandResult(format, manifest, `Added document permission request for ${request.requestedRole}.`);
  return 0;
}

function buildDocumentPermissionRequest(
  flags: Record<string, string | boolean>,
): DocumentPermissionRequestManifestEntry {
  const requestedRole = normalizeDocumentPermissionRole(requireStringFlag(flags, "role"));
  const documentId = getStringFlag(flags, "document-id")?.trim();
  const externalUrl = getStringFlag(flags, "external-url")?.trim();
  const externalFileId = getStringFlag(flags, "external-file-id")?.trim();
  const externalProvider = normalizeExternalProvider(getStringFlag(flags, "external-provider"));
  const sources = [documentId, externalUrl, externalFileId].filter((value) => value && value.length > 0);
  if (sources.length === 0) {
    throw new Error("request-document requires --document-id, --external-file-id, or --external-url.");
  }
  if ((externalUrl || externalFileId) && !externalProvider) {
    throw new Error("External document requests require --external-provider notion|microsoft_365.");
  }
  return removeUndefinedProperties({
    requestedRole,
    reason: requireStringFlag(flags, "reason"),
    documentId,
    externalProvider,
    externalFileId,
    externalUrl,
    targetChannel: getStringFlag(flags, "target-channel")?.trim(),
  }) as DocumentPermissionRequestManifestEntry;
}

function normalizeDocumentPermissionRole(value: string): DocumentPermissionRequestManifestEntry["requestedRole"] {
  if (value === "viewer" || value === "editor" || value === "forwarder") {
    return value;
  }
  if (value === "owner") {
    throw new Error("Agents cannot request owner document access.");
  }
  throw new Error("--role must be viewer, editor, or forwarder.");
}

function normalizeExternalProvider(value: string | undefined): DocumentPermissionRequestManifestEntry["externalProvider"] | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "notion" || value === "microsoft_365") {
    return value;
  }
  throw new Error("--external-provider must be notion or microsoft_365.");
}

function parseCommaSeparatedFlag(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item, index, items) => item.length > 0 && items.indexOf(item) === index);
}

function resolveWorkDir(flags: Record<string, string | boolean>): string {
  return resolve(getStringFlag(flags, "work-dir") ?? process.cwd());
}

function normalizeDocumentMode(value: string | undefined): ChannelDocumentManifestEntry["mode"] {
  if (!value) {
    return "create_or_update";
  }
  if (value === "create" || value === "update" || value === "create_or_update") {
    return value;
  }
  throw new Error("--mode must be create, update, or create_or_update.");
}

function normalizeConflict(value: string | undefined): OutputConflict {
  if (!value) {
    return "skip";
  }
  if (value === "reject" || value === "rename" || value === "replace" || value === "skip") {
    return value;
  }
  throw new Error("--conflict must be reject, rename, replace, or skip.");
}

function normalizeRuntimeArtifactPath(workDir: string, value: string): string {
  const raw = value.replace(/\\/g, "/").trim();
  if (!raw) {
    throw new Error("Artifact path is required.");
  }
  if (isAbsolute(raw)) {
    const artifactsRoot = resolve(workDir, RUNTIME_OUTPUT_ARTIFACTS_RELATIVE_DIR);
    const absolutePath = resolve(raw);
    const relativePath = relative(artifactsRoot, absolutePath).replace(/\\/g, "/");
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Artifact path must be under ${RUNTIME_OUTPUT_ARTIFACTS_RELATIVE_DIR}/.`);
    }
    if (!existsSync(absolutePath)) {
      throw new Error(`Artifact path does not exist: ${raw}`);
    }
    const stats = statSync(absolutePath);
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new Error(`Artifact path is not a file or directory: ${raw}`);
    }
    return `${RUNTIME_OUTPUT_ARTIFACTS_RELATIVE_DIR}/${relativePath}`;
  }
  const segments = raw.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Artifact path cannot contain . or ..");
  }
  if (raw !== RUNTIME_OUTPUT_ARTIFACTS_RELATIVE_DIR && !raw.startsWith(`${RUNTIME_OUTPUT_ARTIFACTS_RELATIVE_DIR}/`)) {
    throw new Error(`Artifact path must be under ${RUNTIME_OUTPUT_ARTIFACTS_RELATIVE_DIR}/.`);
  }
  const absolutePath = resolve(workDir, raw);
  if (!existsSync(absolutePath)) {
    throw new Error(`Artifact path does not exist: ${raw}`);
  }
  const stats = statSync(absolutePath);
  if (!stats.isDirectory() && !stats.isFile()) {
    throw new Error(`Artifact path is not a file or directory: ${raw}`);
  }
  return segments.join("/");
}

function parseBooleanFlag(
  flags: Record<string, string | boolean>,
  key: string,
  fallback: boolean,
): boolean {
  const value = flags[key];
  if (value === undefined) {
    return fallback;
  }
  if (value === true) {
    return true;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`--${key} must be true or false.`);
}

function requireStringFlag(flags: Record<string, string | boolean>, key: string): string {
  const value = getStringFlag(flags, key)?.trim();
  if (!value) {
    throw new Error(`--${key} is required.`);
  }
  return value;
}

function requireNumberFlag(flags: Record<string, string | boolean>, key: string): number {
  const value = requireStringFlag(flags, key);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${key} must be a number.`);
  }
  return parsed;
}

function requireNonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function parseJsonFlag(flags: Record<string, string | boolean>, key: string): unknown {
  const value = requireStringFlag(flags, key);
  return parseJsonFlagValue(value, `--${key}`);
}

function parseJsonFlagValue(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonObjectFlag(value: string, label: string): Record<string, unknown> {
  const parsed = parseJsonFlagValue(value, label);
  if (!isRecord(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function writeCommandResult(format: OutputFormat, value: unknown, message: string): void {
  if (format === "json") {
    writeData(format, value);
    return;
  }
  console.log(message);
}

function printPreview(preview: ReturnType<typeof createRuntimeOutputPreview>): void {
  console.log(`workDir: ${preview.workDir}`);
  console.log(`agent-output: ${preview.manifests.agentOutput.exists ? "yes" : "no"} (${preview.manifests.agentOutput.attachmentCount} attachments, ${preview.manifests.agentOutput.totalAttachmentBytes} bytes)`);
  console.log(`channel-documents: ${preview.manifests.channelDocuments.exists ? "yes" : "no"} (${preview.manifests.channelDocuments.documentOperations} operations)`);
  console.log(`skill-imports: ${preview.manifests.skillImports.exists ? "yes" : "no"} (${preview.manifests.skillImports.imports} imports)`);
  console.log(`permission-requests: ${preview.manifests.permissionRequests.exists ? "yes" : "no"} (${preview.manifests.permissionRequests.requests} requests)`);
  console.log(`feishu-data-operation-requests: ${preview.manifests.feishuDataOperationRequests.exists ? "yes" : "no"} (${preview.manifests.feishuDataOperationRequests.requests} requests)`);
  console.log(`knowledge-proposals: ${preview.manifests.knowledgeProposals.exists ? "yes" : "no"} (${preview.manifests.knowledgeProposals.proposals} proposals)`);
  if (preview.errors.length > 0) {
    console.log("errors:");
    for (const error of preview.errors) {
      console.log(`- ${error}`);
    }
  }
}

function printOutputHelp(): void {
  console.log(`Usage:
  dofe-agent output attach <file> [--name <display-name>] [--media-type <mime>] [--text <message>] [--copy] [--work-dir <path>] [--json]
  dofe-agent output text <message> [--work-dir <path>] [--json]
  dofe-agent output document <command> ...
  dofe-agent output skill import ...
  dofe-agent output knowledge propose-create ...
  dofe-agent output knowledge propose-update ...
  dofe-agent output feishu data-operation-approval ...
  dofe-agent output permission request-document ...
  dofe-agent output validate [--work-dir <path>] [--json]
  dofe-agent output preview [--work-dir <path>] [--json]`);
}

function printDocumentHelp(): void {
  console.log(`Usage:
  dofe-agent output document upsert --title <title> --content <path> [--document-id <id>] [--base-version-id <id>] [--summary <text>] [--mode create|update|create_or_update]
  dofe-agent output document replace-block --document-id <id> --base-version-id <id> --title <title> --block-id <id> --base-revision <n> --content <path> [--heading <text>]
  dofe-agent output document insert-after --document-id <id> --base-version-id <id> --title <title> [--after-block-id <id>] --content <path> [--heading <text>]
  dofe-agent output document delete-block --document-id <id> --base-version-id <id> --title <title> --block-id <id> --base-revision <n>`);
}

function printSkillHelp(): void {
  console.log(`Usage:
  dofe-agent output skill import --url <url> [--conflict reject|rename|replace|skip] [--assign-to-self true|false]
  dofe-agent output skill import --path runtime-output/artifacts/skills/name [--conflict reject|rename|replace|skip]
  dofe-agent output skill import --local-path <path> [--conflict reject|rename|replace|skip]`);
}

function printKnowledgeHelp(): void {
  console.log(`Usage:
  dofe-agent output knowledge propose-create --title <title> --content-file runtime-output/artifacts/knowledge/page.md [--assignment-mode all_agents|selected_agents] [--assigned-employee-names "Agent A,Agent B"] [--assign-to-self true|false] [--tags "tag-a,tag-b"] [--parent-id <page-id>] [--summary <text>] [--reason <text>]
  dofe-agent output knowledge propose-update --knowledge-page-id <page-id> --base-updated-at <iso> --title <title> --content-file runtime-output/artifacts/knowledge/page.md [--assignment-mode all_agents|selected_agents] [--assigned-employee-names "Agent A,Agent B"] [--tags "tag-a,tag-b"] [--summary <text>] [--reason <text>]`);
}

function printFeishuOutputHelp(): void {
  console.log(`Usage:
  dofe-agent output feishu data-operation-approval --operation docs.update_document|sheets.update_range|base.mutate_records --type doc|sheet|base_table --resource <bound-feishu-token> [--parameters-json <json>] [--preview <text>] [--work-dir <path>] [--json]

Common parameter helpers:
  --range <A1> --values-json <json>                  Sheet update range
  --record-id <id> --fields-json <json>              Base record update
  --records-json <json>                              Base batch create/update
  --mutation <value> --blocks-json <json>            Docs append/update mutation
  --parent-block-id <id> --block-id <id>             Docs mutation target`);
}

function printPermissionHelp(): void {
  console.log(`Usage:
  dofe-agent output permission request-document --role viewer|editor|forwarder --reason <text> --document-id <doc-id> [--target-channel <channel>]
  dofe-agent output permission request-document --role viewer|editor|forwarder --reason <text> --external-url <url> --external-provider notion|microsoft_365 [--target-channel <channel>]`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function removeUndefinedProperties<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}

function hasHelpFlag(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}
