import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from "node:path";
import {
  getRuntimeOutputArtifactsDir,
  getRuntimeOutputChannelDocumentsPath,
  getRuntimeOutputPermissionRequestsPath,
  getRuntimeOutputFeishuDataOperationRequestsPath,
  getRuntimeOutputManifestPath,
  getRuntimeOutputKnowledgeProposalsPath,
  getRuntimeOutputSkillImportsPath,
  RUNTIME_OUTPUT_ARTIFACTS_RELATIVE_DIR,
  RUNTIME_OUTPUT_CHANNEL_DOCUMENTS_RELATIVE_PATH,
  RUNTIME_OUTPUT_FEISHU_DATA_OPERATION_REQUESTS_RELATIVE_PATH,
  RUNTIME_OUTPUT_MANIFEST_RELATIVE_PATH,
  RUNTIME_OUTPUT_KNOWLEDGE_PROPOSALS_RELATIVE_PATH,
  RUNTIME_OUTPUT_PERMISSION_REQUESTS_RELATIVE_PATH,
  RUNTIME_OUTPUT_SKILL_IMPORTS_RELATIVE_PATH,
} from "./runtime-output.ts";

export const MAX_OUTPUT_ATTACHMENTS = 5;
export const MAX_OUTPUT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_OUTPUT_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_RUNTIME_OUTPUT_BUNDLE_FILES = 64;
export const MAX_RUNTIME_OUTPUT_BUNDLE_SINGLE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_RUNTIME_OUTPUT_BUNDLE_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_KNOWLEDGE_PROPOSAL_MARKDOWN_BYTES = 256 * 1024;

export const RUNTIME_OUTPUT_MANIFEST_RELATIVE_PATHS = [
  RUNTIME_OUTPUT_MANIFEST_RELATIVE_PATH,
  RUNTIME_OUTPUT_CHANNEL_DOCUMENTS_RELATIVE_PATH,
  RUNTIME_OUTPUT_SKILL_IMPORTS_RELATIVE_PATH,
  RUNTIME_OUTPUT_KNOWLEDGE_PROPOSALS_RELATIVE_PATH,
  RUNTIME_OUTPUT_PERMISSION_REQUESTS_RELATIVE_PATH,
  RUNTIME_OUTPUT_FEISHU_DATA_OPERATION_REQUESTS_RELATIVE_PATH,
] as const;

type RuntimeOutputManifestPath = typeof RUNTIME_OUTPUT_MANIFEST_RELATIVE_PATHS[number];
type SkillImportConflict = "reject" | "rename" | "replace" | "skip";
type AgentAssignableDocumentAccessRole = "viewer" | "editor" | "forwarder";
type KnowledgeProposalOperation = "create" | "update";

export interface AgentOutputAttachmentManifest {
  path: string;
  name?: string;
  mediaType?: string;
}

export interface AgentOutputManifest {
  text?: string;
  attachments?: AgentOutputAttachmentManifest[];
}

export interface ChannelDocumentManifestOperation {
  op: "replace_block" | "insert_after" | "delete_block";
  blockId?: string;
  afterBlockId?: string;
  baseRevision?: number;
  contentPath?: string;
  heading?: string;
}

export interface ChannelDocumentManifestEntry {
  documentId?: string;
  baseVersionId?: string;
  title: string;
  contentPath?: string;
  summary?: string;
  mode?: "create" | "update" | "create_or_update";
  triggerType?: "agent" | "handoff";
  operations?: ChannelDocumentManifestOperation[];
}

export interface ChannelDocumentsManifest {
  documents: ChannelDocumentManifestEntry[];
}

export interface SkillImportManifestEntry {
  url?: string;
  path?: string;
  archivePath?: string;
  conflict?: SkillImportConflict;
  assignToSelf?: boolean;
}

export interface SkillImportsManifest {
  imports: SkillImportManifestEntry[];
}

export interface KnowledgeProposalManifestEntry {
  operation: KnowledgeProposalOperation;
  title: string;
  contentPath: string;
  summary?: string;
  reason?: string;
  tags?: string[];
  parentId?: string | null;
  assignmentMode?: "all_agents" | "selected_agents";
  assignedEmployeeNames?: string[];
  assignToSelf?: boolean;
  targetKnowledgePageId?: string;
  baseUpdatedAt?: string;
}

export interface KnowledgeProposalsManifest {
  version?: 1;
  generatedBy?: "dofe-agent-cli";
  proposals: KnowledgeProposalManifestEntry[];
}

export interface DocumentPermissionRequestManifestEntry {
  requestedRole: AgentAssignableDocumentAccessRole;
  reason: string;
  documentId?: string;
  externalProvider?: "notion" | "microsoft_365";
  externalFileId?: string;
  externalUrl?: string;
  targetChannel?: string;
}

export interface DocumentPermissionRequestsManifest {
  version?: 1;
  generatedBy?: "dofe-agent-cli";
  requests: DocumentPermissionRequestManifestEntry[];
}

export interface RuntimeOutputValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

export interface RuntimeOutputPreview {
  workDir: string;
  manifests: {
    agentOutput: {
      exists: boolean;
      text?: string;
      attachmentCount: number;
      totalAttachmentBytes: number;
    };
    channelDocuments: {
      exists: boolean;
      documentOperations: number;
    };
    skillImports: {
      exists: boolean;
      imports: number;
    };
    knowledgeProposals: {
      exists: boolean;
      proposals: number;
    };
    permissionRequests: {
      exists: boolean;
      requests: number;
    };
    feishuDataOperationRequests: {
      exists: boolean;
      requests: number;
    };
  };
  warnings: string[];
  errors: string[];
}

export interface PreparedRuntimeOutputArtifact {
  relativePath: string;
  absolutePath: string;
  copied: boolean;
}

export interface RuntimeOutputBundleFile {
  path: string;
  contentBase64: string;
}

const ALLOWED_SKILL_IMPORT_HOSTS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "skills.sh",
  "clawhub.ai",
]);

const SENSITIVE_RUNTIME_OUTPUT_PATTERNS = [
  /"refresh_token"\s*:/i,
  /"access_token"\s*:/i,
  /"client_secret"\s*:/i,
  /"private_key"\s*:/i,
  /"credentials?"\s*:/i,
  /["']?authorization["']?\s*:\s*["']?(Bearer|Basic)/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
];

export function readAgentOutputManifest(workDir: string): AgentOutputManifest {
  return readManifestObject<AgentOutputManifest>(getRuntimeOutputManifestPath(workDir), {});
}

export function writeAgentOutputManifest(workDir: string, manifest: AgentOutputManifest): void {
  writeManifestFile(workDir, RUNTIME_OUTPUT_MANIFEST_RELATIVE_PATH, manifest);
}

export function appendAgentOutputAttachment(
  workDir: string,
  attachment: AgentOutputAttachmentManifest,
  text?: string,
): AgentOutputManifest {
  const manifest = readAgentOutputManifest(workDir);
  const next: AgentOutputManifest = {
    ...manifest,
    attachments: [...(Array.isArray(manifest.attachments) ? manifest.attachments : []), attachment],
  };
  if (typeof text === "string") {
    next.text = text;
  }
  writeAgentOutputManifest(workDir, next);
  return next;
}

export function setAgentOutputText(workDir: string, text: string): AgentOutputManifest {
  const manifest = readAgentOutputManifest(workDir);
  const next = {
    ...manifest,
    text,
  } satisfies AgentOutputManifest;
  writeAgentOutputManifest(workDir, next);
  return next;
}

export function readChannelDocumentsManifest(workDir: string): ChannelDocumentsManifest {
  return readManifestObject<ChannelDocumentsManifest>(getRuntimeOutputChannelDocumentsPath(workDir), { documents: [] });
}

export function appendChannelDocumentManifestEntry(
  workDir: string,
  entry: ChannelDocumentManifestEntry,
): ChannelDocumentsManifest {
  const manifest = readChannelDocumentsManifest(workDir);
  const next = {
    ...manifest,
    documents: [...(Array.isArray(manifest.documents) ? manifest.documents : []), entry],
  } satisfies ChannelDocumentsManifest;
  writeManifestFile(workDir, RUNTIME_OUTPUT_CHANNEL_DOCUMENTS_RELATIVE_PATH, next);
  return next;
}

export function readSkillImportsManifest(workDir: string): SkillImportsManifest {
  return readManifestObject<SkillImportsManifest>(getRuntimeOutputSkillImportsPath(workDir), { imports: [] });
}

export function appendSkillImportManifestEntry(
  workDir: string,
  entry: SkillImportManifestEntry,
): SkillImportsManifest {
  const manifest = readSkillImportsManifest(workDir);
  const next = {
    ...manifest,
    imports: [...(Array.isArray(manifest.imports) ? manifest.imports : []), entry],
  } satisfies SkillImportsManifest;
  writeManifestFile(workDir, RUNTIME_OUTPUT_SKILL_IMPORTS_RELATIVE_PATH, next);
  return next;
}

export function readKnowledgeProposalsManifest(workDir: string): KnowledgeProposalsManifest {
  const value = readManifestValue(getRuntimeOutputKnowledgeProposalsPath(workDir), { version: 1, proposals: [] });
  if (value && typeof value === "object" && Array.isArray((value as { proposals?: unknown }).proposals)) {
    return value as KnowledgeProposalsManifest;
  }
  return { version: 1, proposals: [] };
}

export function appendKnowledgeProposalManifestEntry(
  workDir: string,
  entry: KnowledgeProposalManifestEntry,
): KnowledgeProposalsManifest {
  const manifest = readKnowledgeProposalsManifest(workDir);
  const next = {
    version: 1,
    generatedBy: "dofe-agent-cli",
    proposals: [...(Array.isArray(manifest.proposals) ? manifest.proposals : []), entry],
  } satisfies KnowledgeProposalsManifest;
  writeManifestFile(workDir, RUNTIME_OUTPUT_KNOWLEDGE_PROPOSALS_RELATIVE_PATH, next);
  return next;
}

export function readDocumentPermissionRequestsManifest(workDir: string): DocumentPermissionRequestsManifest {
  const value = readManifestValue(getRuntimeOutputPermissionRequestsPath(workDir), { version: 1, requests: [] });
  if (value && typeof value === "object" && Array.isArray((value as { requests?: unknown }).requests)) {
    return value as DocumentPermissionRequestsManifest;
  }
  return { version: 1, requests: [] };
}

export function appendDocumentPermissionRequest(
  workDir: string,
  request: DocumentPermissionRequestManifestEntry,
): DocumentPermissionRequestsManifest {
  const manifest = readDocumentPermissionRequestsManifest(workDir);
  const next = {
    version: 1,
    generatedBy: "dofe-agent-cli",
    requests: [...manifest.requests, request],
  } satisfies DocumentPermissionRequestsManifest;
  writeManifestFile(workDir, RUNTIME_OUTPUT_PERMISSION_REQUESTS_RELATIVE_PATH, next);
  return next;
}

export function prepareRuntimeOutputArtifactReference(input: {
  workDir: string;
  sourcePath: string;
  copyOutsideWorkDir?: boolean;
}): PreparedRuntimeOutputArtifact {
  const workDir = resolve(input.workDir);
  const sourcePath = input.sourcePath.trim();
  if (!sourcePath) {
    throw new Error("File path is required.");
  }
  if (isAbsolute(sourcePath) && !input.copyOutsideWorkDir) {
    throw new Error("Absolute file paths require --copy.");
  }

  const sourceAbsolutePath = isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(workDir, sourcePath);
  if (!existsSync(sourceAbsolutePath)) {
    throw new Error(`File does not exist: ${sourcePath}`);
  }
  if (containsSymlinkBetween(workDir, sourceAbsolutePath) && !input.copyOutsideWorkDir) {
    throw new Error(`File path cannot pass through a symlink: ${sourcePath}`);
  }
  const sourceStats = statSync(sourceAbsolutePath);
  if (!sourceStats.isFile()) {
    throw new Error(`Path is not a file: ${sourcePath}`);
  }
  if (sourceStats.size <= 0) {
    throw new Error(`File is empty: ${sourcePath}`);
  }

  const artifactsDir = getRuntimeOutputArtifactsDir(workDir);
  const realWorkDir = realpathSync(workDir);
  const realSourcePath = realpathSync(sourceAbsolutePath);
  const sourceInsideWorkDir = isPathInside(realWorkDir, realSourcePath);
  const artifactsInsideWorkDir = resolve(workDir, RUNTIME_OUTPUT_ARTIFACTS_RELATIVE_DIR);
  const sourceInsideArtifacts = sourceInsideWorkDir && isPathInside(artifactsInsideWorkDir, sourceAbsolutePath);

  if (!sourceInsideWorkDir && !input.copyOutsideWorkDir) {
    throw new Error("File must be inside workDir unless --copy is provided.");
  }

  if (sourceInsideArtifacts) {
    return {
      absolutePath: sourceAbsolutePath,
      relativePath: normalizePathSeparators(relative(workDir, sourceAbsolutePath)),
      copied: false,
    };
  }

  mkdirSync(artifactsDir, { recursive: true });
  const targetPath = resolveUniqueArtifactPath(artifactsDir, basename(sourceAbsolutePath));
  copyFileSync(sourceAbsolutePath, targetPath);
  return {
    absolutePath: targetPath,
    relativePath: normalizePathSeparators(relative(workDir, targetPath)),
    copied: true,
  };
}

export function validateRuntimeOutputManifests(workDir: string): RuntimeOutputValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  validateAgentOutputManifest(workDir, errors);
  validateChannelDocumentsManifest(workDir, errors);
  validateSkillImportsManifest(workDir, errors);
  validateKnowledgeProposalsManifest(workDir, errors);
  validatePermissionRequestsManifest(workDir, errors);
  validateFeishuDataOperationRequestsManifest(workDir, errors);
  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}

export function createRuntimeOutputPreview(workDir: string): RuntimeOutputPreview {
  const resolvedWorkDir = resolve(workDir);
  const validation = validateRuntimeOutputManifests(resolvedWorkDir);
  return {
    workDir: resolvedWorkDir,
    manifests: {
      agentOutput: summarizeAgentOutputManifest(resolvedWorkDir),
      channelDocuments: summarizeChannelDocumentsManifest(resolvedWorkDir),
      skillImports: summarizeSkillImportsManifest(resolvedWorkDir),
      knowledgeProposals: summarizeKnowledgeProposalsManifest(resolvedWorkDir),
      permissionRequests: summarizePermissionRequestsManifest(resolvedWorkDir),
      feishuDataOperationRequests: summarizeFeishuDataOperationRequestsManifest(resolvedWorkDir),
    },
    warnings: validation.warnings,
    errors: validation.errors,
  };
}

export function collectRuntimeOutputBundleFiles(workDir: string): RuntimeOutputBundleFile[] {
  const files = new Map<string, string>();
  const runtimeOutputDir = resolve(workDir, "runtime-output");
  if (!existsSync(runtimeOutputDir)) {
    return [];
  }

  for (const manifestPath of RUNTIME_OUTPUT_MANIFEST_RELATIVE_PATHS) {
    const absoluteManifestPath = resolve(workDir, manifestPath);
    if (existsSync(absoluteManifestPath)) {
      files.set(manifestPath, absoluteManifestPath);
    }
  }

  addAgentOutputBundleReferences(workDir, files);
  addChannelDocumentBundleReferences(workDir, files);
  addKnowledgeProposalBundleReferences(workDir, files);
  addSkillImportBundleReferences(workDir, files);

  const bundleFiles: RuntimeOutputBundleFile[] = [];
  let totalBytes = 0;
  const sorted = [...files.entries()].sort(([left], [right]) => left.localeCompare(right, "en"));
  if (sorted.length > MAX_RUNTIME_OUTPUT_BUNDLE_FILES) {
    throw new Error(`Runtime output bundle has too many files; max is ${MAX_RUNTIME_OUTPUT_BUNDLE_FILES}.`);
  }

  for (const [relativePath, absolutePath] of sorted) {
    const stats = statSync(absolutePath);
    if (!stats.isFile()) {
      continue;
    }
    if (stats.size > MAX_RUNTIME_OUTPUT_BUNDLE_SINGLE_FILE_BYTES) {
      throw new Error(`Runtime output bundle file exceeds 10 MB: ${relativePath}`);
    }
    totalBytes += stats.size;
    if (totalBytes > MAX_RUNTIME_OUTPUT_BUNDLE_TOTAL_BYTES) {
      throw new Error("Runtime output bundle total size exceeds 25 MB.");
    }
    bundleFiles.push({
      path: relativePath,
      contentBase64: readFileSync(absolutePath).toString("base64"),
    });
  }

  return bundleFiles;
}

function validateAgentOutputManifest(workDir: string, errors: string[]): void {
  const manifestPath = getRuntimeOutputManifestPath(workDir);
  if (!existsSync(manifestPath)) {
    return;
  }
  const parsed = parseJsonManifest(manifestPath, RUNTIME_OUTPUT_MANIFEST_RELATIVE_PATH, errors);
  if (parsed === undefined) {
    return;
  }
  if (!isRecord(parsed)) {
    errors.push(`${RUNTIME_OUTPUT_MANIFEST_RELATIVE_PATH} must be an object.`);
    return;
  }

  if (parsed.text !== undefined && typeof parsed.text !== "string") {
    errors.push(`${RUNTIME_OUTPUT_MANIFEST_RELATIVE_PATH}.text must be a string.`);
  }
  if (parsed.attachments !== undefined && !Array.isArray(parsed.attachments)) {
    errors.push(`${RUNTIME_OUTPUT_MANIFEST_RELATIVE_PATH}.attachments must be an array.`);
    return;
  }

  const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  if (attachments.length > MAX_OUTPUT_ATTACHMENTS) {
    errors.push(`agent-output attachments exceed the limit of ${MAX_OUTPUT_ATTACHMENTS}.`);
  }

  let totalBytes = 0;
  for (const [index, attachment] of attachments.entries()) {
    const label = `${RUNTIME_OUTPUT_MANIFEST_RELATIVE_PATH}.attachments[${index}]`;
    if (!isRecord(attachment)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    if (attachment.name !== undefined && typeof attachment.name !== "string") {
      errors.push(`${label}.name must be a string.`);
    }
    if (attachment.mediaType !== undefined && typeof attachment.mediaType !== "string") {
      errors.push(`${label}.mediaType must be a string.`);
    }
    const file = validateManifestFileReference(workDir, attachment.path, label, errors, {
      requireFile: true,
      requireNonEmpty: true,
    });
    if (!file) {
      continue;
    }
    if (file.sizeBytes > MAX_OUTPUT_ATTACHMENT_BYTES) {
      errors.push(`${label}.path exceeds the single attachment size limit: ${file.relativePath}`);
    }
    totalBytes += file.sizeBytes;
  }
  if (totalBytes > MAX_OUTPUT_ATTACHMENTS_TOTAL_BYTES) {
    errors.push("agent-output attachments exceed the total attachment size limit.");
  }
}

function validateChannelDocumentsManifest(workDir: string, errors: string[]): void {
  const manifestPath = getRuntimeOutputChannelDocumentsPath(workDir);
  if (!existsSync(manifestPath)) {
    return;
  }
  const parsed = parseJsonManifest(manifestPath, RUNTIME_OUTPUT_CHANNEL_DOCUMENTS_RELATIVE_PATH, errors);
  if (parsed === undefined) {
    return;
  }
  if (!isRecord(parsed)) {
    errors.push(`${RUNTIME_OUTPUT_CHANNEL_DOCUMENTS_RELATIVE_PATH} must be an object.`);
    return;
  }
  if (!Array.isArray(parsed.documents)) {
    errors.push(`${RUNTIME_OUTPUT_CHANNEL_DOCUMENTS_RELATIVE_PATH}.documents must be an array.`);
    return;
  }

  for (const [index, document] of parsed.documents.entries()) {
    const label = `${RUNTIME_OUTPUT_CHANNEL_DOCUMENTS_RELATIVE_PATH}.documents[${index}]`;
    if (!isRecord(document)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    if (typeof document.title !== "string" || document.title.trim().length === 0) {
      errors.push(`${label}.title is required.`);
    }
    if (document.mode !== undefined && document.mode !== "create" && document.mode !== "update" && document.mode !== "create_or_update") {
      errors.push(`${label}.mode must be create, update, or create_or_update.`);
    }
    if (document.triggerType !== undefined && document.triggerType !== "agent" && document.triggerType !== "handoff") {
      errors.push(`${label}.triggerType must be agent or handoff.`);
    }

    const contentPath = typeof document.contentPath === "string" ? document.contentPath.trim() : "";
    const operations = Array.isArray(document.operations) ? document.operations : [];
    if (!contentPath && operations.length === 0) {
      errors.push(`${label} must include contentPath or operations[].`);
    }
    if (contentPath) {
      validateManifestFileReference(workDir, contentPath, `${label}.contentPath`, errors, { requireFile: true });
    }
    if (document.operations !== undefined && !Array.isArray(document.operations)) {
      errors.push(`${label}.operations must be an array.`);
      continue;
    }
    for (const [operationIndex, operation] of operations.entries()) {
      validateChannelDocumentOperation(workDir, operation, `${label}.operations[${operationIndex}]`, errors);
    }
  }
}

function validateChannelDocumentOperation(
  workDir: string,
  operation: unknown,
  label: string,
  errors: string[],
): void {
  if (!isRecord(operation)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  if (operation.op !== "replace_block" && operation.op !== "insert_after" && operation.op !== "delete_block") {
    errors.push(`${label}.op is not supported.`);
    return;
  }
  if (operation.op === "replace_block" || operation.op === "delete_block") {
    if (typeof operation.blockId !== "string" || operation.blockId.trim().length === 0) {
      errors.push(`${label}.blockId is required.`);
    }
    if (typeof operation.baseRevision !== "number" || !Number.isFinite(operation.baseRevision)) {
      errors.push(`${label}.baseRevision is required.`);
    }
  }
  if (operation.op === "replace_block" || operation.op === "insert_after") {
    const contentPath = typeof operation.contentPath === "string" ? operation.contentPath.trim() : "";
    if (!contentPath) {
      errors.push(`${label}.contentPath is required.`);
      return;
    }
    validateManifestFileReference(workDir, contentPath, `${label}.contentPath`, errors, { requireFile: true });
  }
}

function validateSkillImportsManifest(workDir: string, errors: string[]): void {
  const manifestPath = getRuntimeOutputSkillImportsPath(workDir);
  if (!existsSync(manifestPath)) {
    return;
  }
  const parsed = parseJsonManifest(manifestPath, RUNTIME_OUTPUT_SKILL_IMPORTS_RELATIVE_PATH, errors);
  if (parsed === undefined) {
    return;
  }
  if (!isRecord(parsed)) {
    errors.push(`${RUNTIME_OUTPUT_SKILL_IMPORTS_RELATIVE_PATH} must be an object.`);
    return;
  }
  if (!Array.isArray(parsed.imports)) {
    errors.push(`${RUNTIME_OUTPUT_SKILL_IMPORTS_RELATIVE_PATH}.imports must be an array.`);
    return;
  }

  for (const [index, entry] of parsed.imports.entries()) {
    const label = `${RUNTIME_OUTPUT_SKILL_IMPORTS_RELATIVE_PATH}.imports[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    const sources = [
      typeof entry.url === "string" && entry.url.trim().length > 0 ? "url" : "",
      typeof entry.path === "string" && entry.path.trim().length > 0 ? "path" : "",
      typeof entry.archivePath === "string" && entry.archivePath.trim().length > 0 ? "archivePath" : "",
    ].filter(Boolean);
    if (sources.length !== 1) {
      errors.push(`${label} must provide exactly one of url, path, or archivePath.`);
    }
    if (entry.conflict !== undefined && entry.conflict !== "reject" && entry.conflict !== "rename" && entry.conflict !== "replace" && entry.conflict !== "skip") {
      errors.push(`${label}.conflict must be reject, rename, replace, or skip.`);
    }
    if (entry.assignToSelf !== undefined && typeof entry.assignToSelf !== "boolean") {
      errors.push(`${label}.assignToSelf must be a boolean.`);
    }
    if (typeof entry.url === "string" && entry.url.trim().length > 0) {
      validateSkillImportUrl(entry.url, `${label}.url`, errors);
    }
    if (typeof entry.path === "string" && entry.path.trim().length > 0) {
      validateSkillArtifactReference(workDir, entry.path, `${label}.path`, errors, false);
    }
    if (typeof entry.archivePath === "string" && entry.archivePath.trim().length > 0) {
      validateSkillArtifactReference(workDir, entry.archivePath, `${label}.archivePath`, errors, true);
    }
  }
}

function validateKnowledgeProposalsManifest(workDir: string, errors: string[]): void {
  const manifestPath = getRuntimeOutputKnowledgeProposalsPath(workDir);
  if (!existsSync(manifestPath)) {
    return;
  }
  validateNoSensitiveOutput(readFileSync(manifestPath, "utf8"), RUNTIME_OUTPUT_KNOWLEDGE_PROPOSALS_RELATIVE_PATH, errors);
  const parsed = parseJsonManifest(manifestPath, RUNTIME_OUTPUT_KNOWLEDGE_PROPOSALS_RELATIVE_PATH, errors);
  if (parsed === undefined) {
    return;
  }
  if (!isRecord(parsed)) {
    errors.push(`${RUNTIME_OUTPUT_KNOWLEDGE_PROPOSALS_RELATIVE_PATH} must be an object.`);
    return;
  }
  if (parsed.version !== undefined && parsed.version !== 1) {
    errors.push(`${RUNTIME_OUTPUT_KNOWLEDGE_PROPOSALS_RELATIVE_PATH}.version must be 1.`);
  }
  if (parsed.generatedBy !== "dofe-agent-cli") {
    errors.push(`${RUNTIME_OUTPUT_KNOWLEDGE_PROPOSALS_RELATIVE_PATH}.generatedBy must be dofe-agent-cli; use dofe-agent output knowledge propose-create/propose-update.`);
  }
  if (!Array.isArray(parsed.proposals)) {
    errors.push(`${RUNTIME_OUTPUT_KNOWLEDGE_PROPOSALS_RELATIVE_PATH}.proposals must be an array.`);
    return;
  }

  for (const [index, proposal] of parsed.proposals.entries()) {
    const label = `${RUNTIME_OUTPUT_KNOWLEDGE_PROPOSALS_RELATIVE_PATH}.proposals[${index}]`;
    if (!isRecord(proposal)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    if (proposal.operation !== "create" && proposal.operation !== "update") {
      errors.push(`${label}.operation must be create or update.`);
    }
    if (typeof proposal.title !== "string" || proposal.title.trim().length === 0) {
      errors.push(`${label}.title is required.`);
    }
    if (proposal.summary !== undefined && typeof proposal.summary !== "string") {
      errors.push(`${label}.summary must be a string.`);
    }
    if (proposal.reason !== undefined && typeof proposal.reason !== "string") {
      errors.push(`${label}.reason must be a string.`);
    }
    if (proposal.parentId !== undefined && proposal.parentId !== null && typeof proposal.parentId !== "string") {
      errors.push(`${label}.parentId must be a string or null.`);
    }
    if (proposal.assignmentMode !== undefined && proposal.assignmentMode !== "all_agents" && proposal.assignmentMode !== "selected_agents") {
      errors.push(`${label}.assignmentMode must be all_agents or selected_agents.`);
    }
    if (proposal.assignToSelf !== undefined && typeof proposal.assignToSelf !== "boolean") {
      errors.push(`${label}.assignToSelf must be a boolean.`);
    }
    if (proposal.tags !== undefined && (!Array.isArray(proposal.tags) || proposal.tags.some((tag) => typeof tag !== "string"))) {
      errors.push(`${label}.tags must be an array of strings.`);
    }
    if (proposal.assignedEmployeeNames !== undefined && (!Array.isArray(proposal.assignedEmployeeNames) || proposal.assignedEmployeeNames.some((name) => typeof name !== "string"))) {
      errors.push(`${label}.assignedEmployeeNames must be an array of strings.`);
    }
    if (proposal.operation === "update") {
      if (typeof proposal.targetKnowledgePageId !== "string" || proposal.targetKnowledgePageId.trim().length === 0) {
        errors.push(`${label}.targetKnowledgePageId is required for update.`);
      }
      if (typeof proposal.baseUpdatedAt !== "string" || proposal.baseUpdatedAt.trim().length === 0) {
        errors.push(`${label}.baseUpdatedAt is required for update.`);
      }
    }
    const file = validateManifestFileReference(workDir, proposal.contentPath, `${label}.contentPath`, errors, {
      requireFile: true,
      requireNonEmpty: true,
    });
    if (!file) {
      continue;
    }
    if (file.sizeBytes > MAX_KNOWLEDGE_PROPOSAL_MARKDOWN_BYTES) {
      errors.push(`${label}.contentPath exceeds the 256 KB knowledge proposal size limit.`);
    }
    if (!isRuntimeOutputArtifactsReference(file.relativePath)) {
      errors.push(`${label}.contentPath must be under ${RUNTIME_OUTPUT_ARTIFACTS_RELATIVE_DIR}/.`);
    }
    if (!file.relativePath.toLocaleLowerCase("en-US").endsWith(".md")) {
      errors.push(`${label}.contentPath must point to a Markdown .md file.`);
    }
    validateNoSensitiveOutput(readFileSync(file.absolutePath, "utf8"), `${label}.contentPath`, errors);
  }
}

function validatePermissionRequestsManifest(workDir: string, errors: string[]): void {
  const manifestPath = getRuntimeOutputPermissionRequestsPath(workDir);
  if (!existsSync(manifestPath)) {
    return;
  }
  const parsed = parseJsonManifest(manifestPath, RUNTIME_OUTPUT_PERMISSION_REQUESTS_RELATIVE_PATH, errors);
  if (parsed === undefined) {
    return;
  }
  if (!isRecord(parsed)) {
    errors.push(`${RUNTIME_OUTPUT_PERMISSION_REQUESTS_RELATIVE_PATH} must be an object.`);
    return;
  }
  if (parsed.version !== undefined && parsed.version !== 1) {
    errors.push(`${RUNTIME_OUTPUT_PERMISSION_REQUESTS_RELATIVE_PATH}.version must be 1.`);
  }
  if (parsed.generatedBy !== "dofe-agent-cli") {
    errors.push(`${RUNTIME_OUTPUT_PERMISSION_REQUESTS_RELATIVE_PATH}.generatedBy must be dofe-agent-cli; use dofe-agent output permission request-document.`);
  }
  if (!Array.isArray(parsed.requests)) {
    errors.push(`${RUNTIME_OUTPUT_PERMISSION_REQUESTS_RELATIVE_PATH}.requests must be an array.`);
    return;
  }
  for (const [index, request] of parsed.requests.entries()) {
    const label = `${RUNTIME_OUTPUT_PERMISSION_REQUESTS_RELATIVE_PATH}.requests[${index}]`;
    if (!isRecord(request)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    if (!isAgentAssignableDocumentRole(request.requestedRole)) {
      errors.push(`${label}.requestedRole must be viewer, editor, or forwarder.`);
    }
    if (typeof request.reason !== "string" || request.reason.trim().length === 0) {
      errors.push(`${label}.reason is required.`);
    }
    const sources = [
      typeof request.documentId === "string" && request.documentId.trim().length > 0 ? "documentId" : "",
      typeof request.externalFileId === "string" && request.externalFileId.trim().length > 0 ? "externalFileId" : "",
      typeof request.externalUrl === "string" && request.externalUrl.trim().length > 0 ? "externalUrl" : "",
    ].filter(Boolean);
    if (sources.length === 0) {
      errors.push(`${label} requires documentId, externalFileId, or externalUrl.`);
    }
    if (request.externalProvider !== undefined && request.externalProvider !== "notion" && request.externalProvider !== "microsoft_365") {
      errors.push(`${label}.externalProvider is not supported.`);
    }
    if ((request.externalFileId || request.externalUrl) && !request.externalProvider) {
      errors.push(`${label}.externalProvider is required for external document requests.`);
    }
    if (request.targetChannel !== undefined && typeof request.targetChannel !== "string") {
      errors.push(`${label}.targetChannel must be a string.`);
    }
  }
}

function validateFeishuDataOperationRequestsManifest(workDir: string, errors: string[]): void {
  const manifestPath = getRuntimeOutputFeishuDataOperationRequestsPath(workDir);
  if (!existsSync(manifestPath)) {
    return;
  }
  const parsed = parseJsonManifest(manifestPath, RUNTIME_OUTPUT_FEISHU_DATA_OPERATION_REQUESTS_RELATIVE_PATH, errors);
  if (parsed === undefined) {
    return;
  }
  if (!isRecord(parsed)) {
    errors.push(`${RUNTIME_OUTPUT_FEISHU_DATA_OPERATION_REQUESTS_RELATIVE_PATH} must be an object.`);
    return;
  }
  if (parsed.kind !== "dofe-agent.feishu.data-operation.requests") {
    errors.push(`${RUNTIME_OUTPUT_FEISHU_DATA_OPERATION_REQUESTS_RELATIVE_PATH}.kind must be dofe-agent.feishu.data-operation.requests.`);
  }
  if (parsed.schemaVersion !== 1) {
    errors.push(`${RUNTIME_OUTPUT_FEISHU_DATA_OPERATION_REQUESTS_RELATIVE_PATH}.schemaVersion must be 1.`);
  }
  if (parsed.generatedBy !== "dofe-agent-cli") {
    errors.push(`${RUNTIME_OUTPUT_FEISHU_DATA_OPERATION_REQUESTS_RELATIVE_PATH}.generatedBy must be dofe-agent-cli; use dofe-agent output feishu data-operation-approval.`);
  }
  if (!Array.isArray(parsed.requests)) {
    errors.push(`${RUNTIME_OUTPUT_FEISHU_DATA_OPERATION_REQUESTS_RELATIVE_PATH}.requests must be an array.`);
    return;
  }
  for (const [index, request] of parsed.requests.entries()) {
    const label = `${RUNTIME_OUTPUT_FEISHU_DATA_OPERATION_REQUESTS_RELATIVE_PATH}.requests[${index}]`;
    if (!isRecord(request)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    for (const key of ["operationType", "providerResourceType", "providerResourceToken"]) {
      if (typeof request[key] !== "string" || request[key].trim().length === 0) {
        errors.push(`${label}.${key} is required.`);
      }
    }
    if (request.parameters !== undefined && !isRecord(request.parameters)) {
      errors.push(`${label}.parameters must be an object.`);
    }
    if (request.contentPreview !== undefined && typeof request.contentPreview !== "string") {
      errors.push(`${label}.contentPreview must be a string.`);
    }
  }
}

function summarizeAgentOutputManifest(workDir: string): RuntimeOutputPreview["manifests"]["agentOutput"] {
  const manifestPath = getRuntimeOutputManifestPath(workDir);
  if (!existsSync(manifestPath)) {
    return { exists: false, attachmentCount: 0, totalAttachmentBytes: 0 };
  }
  const parsed = parseJsonManifestQuiet(manifestPath);
  if (!isRecord(parsed)) {
    return { exists: true, attachmentCount: 0, totalAttachmentBytes: 0 };
  }
  const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  let totalAttachmentBytes = 0;
  for (const attachment of attachments) {
    if (!isRecord(attachment)) {
      continue;
    }
    const file = resolveManifestPath(workDir, attachment.path);
    if (!file || !existsSync(file.absolutePath)) {
      continue;
    }
    const stats = statSync(file.absolutePath);
    if (stats.isFile()) {
      totalAttachmentBytes += stats.size;
    }
  }
  return {
    exists: true,
    text: typeof parsed.text === "string" ? parsed.text : undefined,
    attachmentCount: attachments.length,
    totalAttachmentBytes,
  };
}

function summarizeChannelDocumentsManifest(workDir: string): RuntimeOutputPreview["manifests"]["channelDocuments"] {
  const manifestPath = getRuntimeOutputChannelDocumentsPath(workDir);
  if (!existsSync(manifestPath)) {
    return { exists: false, documentOperations: 0 };
  }
  const parsed = parseJsonManifestQuiet(manifestPath);
  if (!isRecord(parsed) || !Array.isArray(parsed.documents)) {
    return { exists: true, documentOperations: 0 };
  }
  const documentOperations = parsed.documents.reduce((count, document) => {
    if (!isRecord(document)) {
      return count;
    }
    const contentOperationCount = typeof document.contentPath === "string" && document.contentPath.trim() ? 1 : 0;
    const blockOperationCount = Array.isArray(document.operations) ? document.operations.length : 0;
    return count + contentOperationCount + blockOperationCount;
  }, 0);
  return { exists: true, documentOperations };
}

function summarizeSkillImportsManifest(workDir: string): RuntimeOutputPreview["manifests"]["skillImports"] {
  const manifestPath = getRuntimeOutputSkillImportsPath(workDir);
  if (!existsSync(manifestPath)) {
    return { exists: false, imports: 0 };
  }
  const parsed = parseJsonManifestQuiet(manifestPath);
  return {
    exists: true,
    imports: isRecord(parsed) && Array.isArray(parsed.imports) ? parsed.imports.length : 0,
  };
}

function summarizeKnowledgeProposalsManifest(workDir: string): RuntimeOutputPreview["manifests"]["knowledgeProposals"] {
  const manifestPath = getRuntimeOutputKnowledgeProposalsPath(workDir);
  if (!existsSync(manifestPath)) {
    return { exists: false, proposals: 0 };
  }
  const parsed = parseJsonManifestQuiet(manifestPath);
  return {
    exists: true,
    proposals: isRecord(parsed) && Array.isArray(parsed.proposals) ? parsed.proposals.length : 0,
  };
}

function summarizePermissionRequestsManifest(workDir: string): RuntimeOutputPreview["manifests"]["permissionRequests"] {
  const manifestPath = getRuntimeOutputPermissionRequestsPath(workDir);
  if (!existsSync(manifestPath)) {
    return { exists: false, requests: 0 };
  }
  const parsed = parseJsonManifestQuiet(manifestPath);
  return {
    exists: true,
    requests: isRecord(parsed) && Array.isArray(parsed.requests) ? parsed.requests.length : 0,
  };
}

function summarizeFeishuDataOperationRequestsManifest(workDir: string): RuntimeOutputPreview["manifests"]["feishuDataOperationRequests"] {
  const manifestPath = getRuntimeOutputFeishuDataOperationRequestsPath(workDir);
  if (!existsSync(manifestPath)) {
    return { exists: false, requests: 0 };
  }
  const parsed = parseJsonManifestQuiet(manifestPath);
  return {
    exists: true,
    requests: isRecord(parsed) && Array.isArray(parsed.requests) ? parsed.requests.length : 0,
  };
}

function addAgentOutputBundleReferences(workDir: string, files: Map<string, string>): void {
  const manifestPath = getRuntimeOutputManifestPath(workDir);
  const parsed = existsSync(manifestPath) ? parseJsonManifestQuiet(manifestPath) : undefined;
  if (!isRecord(parsed) || !Array.isArray(parsed.attachments)) {
    return;
  }
  for (const attachment of parsed.attachments) {
    if (!isRecord(attachment)) {
      continue;
    }
    addBundlePathReference(workDir, attachment.path, files, { allowDirectory: false });
  }
}

function addChannelDocumentBundleReferences(workDir: string, files: Map<string, string>): void {
  const manifestPath = getRuntimeOutputChannelDocumentsPath(workDir);
  const parsed = existsSync(manifestPath) ? parseJsonManifestQuiet(manifestPath) : undefined;
  if (!isRecord(parsed) || !Array.isArray(parsed.documents)) {
    return;
  }
  for (const document of parsed.documents) {
    if (!isRecord(document)) {
      continue;
    }
    addBundlePathReference(workDir, document.contentPath, files, { allowDirectory: false });
    const operations = Array.isArray(document.operations) ? document.operations : [];
    for (const operation of operations) {
      if (isRecord(operation)) {
        addBundlePathReference(workDir, operation.contentPath, files, { allowDirectory: false });
      }
    }
  }
}

function addKnowledgeProposalBundleReferences(workDir: string, files: Map<string, string>): void {
  const manifestPath = getRuntimeOutputKnowledgeProposalsPath(workDir);
  const parsed = existsSync(manifestPath) ? parseJsonManifestQuiet(manifestPath) : undefined;
  if (!isRecord(parsed) || !Array.isArray(parsed.proposals)) {
    return;
  }
  for (const proposal of parsed.proposals) {
    if (!isRecord(proposal)) {
      continue;
    }
    addBundlePathReference(workDir, proposal.contentPath, files, { allowDirectory: false, requireArtifacts: true });
  }
}

function addSkillImportBundleReferences(workDir: string, files: Map<string, string>): void {
  const manifestPath = getRuntimeOutputSkillImportsPath(workDir);
  const parsed = existsSync(manifestPath) ? parseJsonManifestQuiet(manifestPath) : undefined;
  if (!isRecord(parsed) || !Array.isArray(parsed.imports)) {
    return;
  }
  for (const entry of parsed.imports) {
    if (!isRecord(entry)) {
      continue;
    }
    addBundlePathReference(workDir, entry.path, files, { allowDirectory: true, requireArtifacts: true });
    addBundlePathReference(workDir, entry.archivePath, files, { allowDirectory: false, requireArtifacts: true });
  }
}

function addBundlePathReference(
  workDir: string,
  value: unknown,
  files: Map<string, string>,
  options: {
    allowDirectory: boolean;
    requireArtifacts?: boolean;
  },
): void {
  const normalized = normalizeManifestRelativePath(value);
  if (!normalized) {
    return;
  }
  if (options.requireArtifacts && !isRuntimeOutputArtifactsReference(normalized.relativePath)) {
    return;
  }
  if (!isRuntimeOutputReference(normalized.relativePath)) {
    return;
  }
  const absolutePath = resolve(workDir, normalized.relativePath);
  if (!existsSync(absolutePath)) {
    return;
  }
  const linkStats = lstatSync(absolutePath);
  if (linkStats.isSymbolicLink()) {
    throw new Error(`Runtime output bundle path cannot be a symlink: ${normalized.relativePath}`);
  }
  const stats = statSync(absolutePath);
  if (stats.isDirectory()) {
    if (!options.allowDirectory) {
      return;
    }
    addBundleDirectory(workDir, normalized.relativePath, absolutePath, files);
    return;
  }
  if (stats.isFile()) {
    files.set(normalized.relativePath, absolutePath);
  }
}

function addBundleDirectory(
  workDir: string,
  relativeDir: string,
  absoluteDir: string,
  files: Map<string, string>,
): void {
  const entries = readdirSync(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = `${relativeDir}/${entry.name}`;
    const absolutePath = join(absoluteDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Runtime output bundle path cannot be a symlink: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      addBundleDirectory(workDir, normalizePathSeparators(relativePath), absolutePath, files);
      continue;
    }
    if (entry.isFile()) {
      if (!isRuntimeOutputArtifactsReference(relativePath)) {
        continue;
      }
      const resolved = resolveManifestPath(workDir, relativePath);
      if (resolved && existsSync(resolved.absolutePath)) {
        files.set(resolved.relativePath, resolved.absolutePath);
      }
    }
  }
}

function validateSkillImportUrl(value: string, label: string, errors: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    errors.push(`${label} must be a valid URL.`);
    return;
  }
  if (parsed.protocol !== "https:") {
    errors.push(`${label} must use HTTPS.`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_SKILL_IMPORT_HOSTS.has(hostname) && !hostname.endsWith(".clawhub.ai")) {
    errors.push(`${label} host is not allowed.`);
  }
}

function validateSkillArtifactReference(
  workDir: string,
  value: string,
  label: string,
  errors: string[],
  archive: boolean,
): void {
  const normalized = normalizeManifestRelativePath(value);
  if (!normalized) {
    errors.push(`${label} must be a non-empty relative path.`);
    return;
  }
  if (!isRuntimeOutputArtifactsReference(normalized.relativePath)) {
    errors.push(`${label} must be under ${RUNTIME_OUTPUT_ARTIFACTS_RELATIVE_DIR}/.`);
    return;
  }
  if (archive && !normalized.relativePath.toLocaleLowerCase("en-US").endsWith(".zip")) {
    errors.push(`${label} must point to a .zip file.`);
  }
  validateManifestFileReference(workDir, normalized.relativePath, label, errors, {
    requireExists: true,
    requireFile: archive,
  });
}

function validateNoSensitiveOutput(value: string, label: string, errors: string[]): void {
  if (SENSITIVE_RUNTIME_OUTPUT_PATTERNS.some((pattern) => pattern.test(value))) {
    errors.push(`${label} appears to contain sensitive credential material; remove credentials before uploading runtime-output.`);
  }
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isAgentAssignableDocumentRole(value: unknown): value is AgentAssignableDocumentAccessRole {
  return value === "viewer" || value === "editor" || value === "forwarder";
}

function validateManifestFileReference(
  workDir: string,
  value: unknown,
  label: string,
  errors: string[],
  options: {
    requireExists?: boolean;
    requireFile?: boolean;
    requireNonEmpty?: boolean;
  },
): { relativePath: string; absolutePath: string; sizeBytes: number } | null {
  const normalized = normalizeManifestRelativePath(value);
  if (!normalized) {
    errors.push(`${label} must be a non-empty relative path.`);
    return null;
  }
  const resolved = resolveManifestPath(workDir, normalized.relativePath);
  if (!resolved) {
    errors.push(`${label} escapes workDir: ${normalized.relativePath}`);
    return null;
  }
  if (!existsSync(resolved.absolutePath)) {
    if (options.requireExists !== false) {
      errors.push(`${label} does not exist: ${normalized.relativePath}`);
    }
    return null;
  }
  if (containsSymlinkBetween(workDir, resolved.absolutePath)) {
    errors.push(`${label} cannot pass through a symlink: ${normalized.relativePath}`);
    return null;
  }
  const stats = statSync(resolved.absolutePath);
  if (options.requireFile && !stats.isFile()) {
    errors.push(`${label} is not a file: ${normalized.relativePath}`);
    return null;
  }
  if (options.requireNonEmpty && stats.size <= 0) {
    errors.push(`${label} is empty: ${normalized.relativePath}`);
    return null;
  }
  return {
    relativePath: normalized.relativePath,
    absolutePath: resolved.absolutePath,
    sizeBytes: stats.size,
  };
}

function normalizeManifestRelativePath(value: unknown): { relativePath: string } | null {
  if (typeof value !== "string") {
    return null;
  }
  const relativePath = value.replace(/\\/g, "/").trim();
  if (!relativePath || isAbsolute(relativePath)) {
    return null;
  }
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return { relativePath: segments.join("/") };
}

function resolveManifestPath(workDir: string, relativePath: unknown): { relativePath: string; absolutePath: string } | null {
  const normalized = normalizeManifestRelativePath(relativePath);
  if (!normalized) {
    return null;
  }
  const absolutePath = resolve(workDir, normalized.relativePath);
  if (!isPathInside(resolve(workDir), absolutePath)) {
    return null;
  }
  if (existsSync(absolutePath)) {
    const realWorkDir = realpathSync(workDir);
    const realPath = realpathSync(absolutePath);
    if (!isPathInside(realWorkDir, realPath)) {
      return null;
    }
  }
  return {
    relativePath: normalized.relativePath,
    absolutePath,
  };
}

function isRuntimeOutputReference(value: string): boolean {
  return value === "runtime-output" || value.startsWith("runtime-output/");
}

function isRuntimeOutputArtifactsReference(value: string): boolean {
  return value === RUNTIME_OUTPUT_ARTIFACTS_RELATIVE_DIR || value.startsWith(`${RUNTIME_OUTPUT_ARTIFACTS_RELATIVE_DIR}/`);
}

function readManifestObject<T extends object>(path: string, fallback: T): T {
  const value = readManifestValue(path, fallback);
  return isRecord(value) ? (value as T) : fallback;
}

function readManifestValue(path: string, fallback: unknown): unknown {
  if (!existsSync(path)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return fallback;
  }
}

function writeManifestFile(workDir: string, relativePath: RuntimeOutputManifestPath, value: unknown): void {
  const absolutePath = resolve(workDir, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseJsonManifest(path: string, relativePath: string, errors: string[]): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    errors.push(`${relativePath} JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function parseJsonManifestQuiet(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveUniqueArtifactPath(artifactsDir: string, fileName: string): string {
  const safeFileName = sanitizeFileName(fileName);
  const parsed = parse(safeFileName);
  let candidate = join(artifactsDir, safeFileName);
  let index = 2;
  while (existsSync(candidate)) {
    candidate = join(artifactsDir, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

function sanitizeFileName(value: string): string {
  const clean = basename(value).replace(/[^\w .-]+/g, "-").replace(/^-+|-+$/g, "");
  if (clean.trim().length > 0 && clean !== "." && clean !== "..") {
    return clean;
  }
  return `artifact${extname(value)}`;
}

function containsSymlinkBetween(baseDir: string, targetPath: string): boolean {
  const relativePath = relative(baseDir, targetPath);
  if (!relativePath || relativePath === ".") {
    return false;
  }

  let currentPath = baseDir;
  for (const segment of relativePath.split(/[\\/]+/).filter((item) => item.length > 0)) {
    currentPath = join(currentPath, segment);
    if (existsSync(currentPath) && lstatSync(currentPath).isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

function isPathInside(rootDir: string, candidatePath: string): boolean {
  const relativePath = relative(rootDir, candidatePath);
  return (
    relativePath === ""
    || relativePath === "."
    || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}
