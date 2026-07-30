import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { TosClient } from "@volcengine/tos-sdk";
import {
  type AttachmentRuntimeConfig,
  resolveAttachmentRuntimeConfig,
} from "../config/deployment.ts";

const TOS_SIGNED_URL_TTL_SECONDS = 300;

export interface StoredAttachmentObject {
  provider: "tos" | "local";
  bucket?: string;
  region?: string;
  endpoint?: string;
  key?: string;
  url?: string;
  storedPath: string;
  sizeBytes: number;
  sha256: string;
}

export interface AttachmentStoragePutInput {
  workspaceId: string;
  attachmentId: string;
  fileName: string;
  contentBytes: Uint8Array;
  mediaType?: string;
}

export interface AttachmentStorageReadInput {
  storageProvider?: string;
  storageBucket?: string;
  storageRegion?: string;
  storageEndpoint?: string;
  storageKey?: string;
  storedPath: string;
}

export interface AttachmentStorageObjectMetadata {
  provider: "tos" | "local";
  bucket?: string;
  region?: string;
  endpoint?: string;
  key?: string;
  storedPath: string;
  sizeBytes?: number;
  contentType?: string;
  etag?: string;
  lastModified?: string;
}

export interface AttachmentStorageClient {
  putObject(input: AttachmentStoragePutInput): Promise<StoredAttachmentObject>;
  putObjectSync(input: AttachmentStoragePutInput): StoredAttachmentObject;
  getObject(input: AttachmentStorageReadInput): Promise<Uint8Array>;
  getObjectSync(input: AttachmentStorageReadInput): Uint8Array;
  headObject(input: AttachmentStorageReadInput): Promise<AttachmentStorageObjectMetadata | null>;
  deleteObject(input: AttachmentStorageReadInput): Promise<void>;
  deleteObjectSync(input: AttachmentStorageReadInput): void;
  createReadUrl(input: AttachmentStorageReadInput): Promise<string | null>;
}

let testStorageClient: AttachmentStorageClient | undefined;

export function createAttachmentStorageClient(config?: AttachmentRuntimeConfig): AttachmentStorageClient {
  if (testStorageClient) {
    return testStorageClient;
  }
  const resolvedConfig = config ?? resolveAttachmentRuntimeConfig();
  return resolvedConfig.provider === "local"
    ? new LocalAttachmentStorageClient(resolvedConfig)
    : new TosAttachmentStorageClient(resolvedConfig);
}

export function setAttachmentStorageClientForTests(client: AttachmentStorageClient | undefined): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Attachment storage overrides are only available in tests.");
  }
  testStorageClient = client;
}

export function buildAttachmentStorageKey(input: {
  workspaceId: string;
  attachmentId: string;
  fileName: string;
  createdAt?: Date;
}): string {
  const createdAt = input.createdAt ?? new Date();
  const year = String(createdAt.getUTCFullYear());
  const month = String(createdAt.getUTCMonth() + 1).padStart(2, "0");
  return [
    "workspaces",
    sanitizeObjectKeySegment(input.workspaceId),
    "attachments",
    year,
    month,
    sanitizeObjectKeySegment(input.attachmentId),
    sanitizeObjectKeySegment(input.fileName) || "attachment.bin",
  ].join("/");
}

export function sha256Hex(contentBytes: Uint8Array): string {
  return createHash("sha256").update(contentBytes).digest("hex");
}

class TosAttachmentStorageClient implements AttachmentStorageClient {
  private readonly config: Extract<AttachmentRuntimeConfig, { provider: "tos" }>["tos"];
  private readonly client: TosClient;

  constructor(config: Extract<AttachmentRuntimeConfig, { provider: "tos" }>) {
    this.config = config.tos;
    this.client = new TosClient({
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.secretAccessKey,
      endpoint: toEndpointHost(this.config.endpoint),
      region: this.config.region,
    });
  }

  async putObject(input: AttachmentStoragePutInput): Promise<StoredAttachmentObject> {
    const object = this.buildStoredObject(input);
    await this.client.putObject({
      bucket: this.config.bucket,
      key: object.key,
      body: Buffer.from(input.contentBytes),
      contentType: input.mediaType,
    });
    return object;
  }

  putObjectSync(input: AttachmentStoragePutInput): StoredAttachmentObject {
    const object = this.buildStoredObject(input);
    const body = Buffer.from(input.contentBytes);
    const signedUrl = this.createPresignedUrl(object.key, "PUT");
    const args = [
      "--fail",
      "-sS",
      "-X",
      "PUT",
      signedUrl,
      "--data-binary",
      "@-",
    ];
    if (input.mediaType) {
      args.splice(args.length - 2, 0, "-H", `Content-Type: ${input.mediaType}`);
    }
    const result = spawnSync("curl", args, {
      input: body,
      maxBuffer: 1024 * 1024,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const output = Buffer.concat([
        Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
        Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? ""),
      ]).toString("utf8");
      throw new Error(`TOS upload failed: ${output.trim() || `curl exited with status ${result.status}`}`);
    }
    return object;
  }

  private buildStoredObject(input: AttachmentStoragePutInput): StoredAttachmentObject & { key: string } {
    const storageKey = buildAttachmentStorageKey(input);

    return {
      provider: "tos",
      bucket: this.config.bucket,
      region: this.config.region,
      endpoint: this.config.endpoint,
      key: storageKey,
      storedPath: `tos://${this.config.bucket}/${storageKey}`,
      sizeBytes: input.contentBytes.byteLength,
      sha256: sha256Hex(input.contentBytes),
    };
  }

  async getObject(input: AttachmentStorageReadInput): Promise<Uint8Array> {
    const key = input.storageKey?.trim();
    if (!key) {
      throw new Error("Missing object storage key.");
    }
    const response = await this.client.getObjectV2({
      bucket: input.storageBucket ?? this.config.bucket,
      key,
      dataType: "buffer",
    });
    if (!Buffer.isBuffer(response.data.content)) {
      throw new Error("TOS returned an unexpected object response.");
    }
    return new Uint8Array(response.data.content);
  }

  getObjectSync(input: AttachmentStorageReadInput): Uint8Array {
    const key = input.storageKey?.trim();
    if (!key) {
      throw new Error("Missing object storage key.");
    }
    const result = spawnSync("curl", ["--fail", "-sS", this.createPresignedUrl(key, "GET")], {
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const output = Buffer.isBuffer(result.stderr)
        ? result.stderr.toString("utf8")
        : String(result.stderr ?? "");
      throw new Error(`TOS read failed: ${output.trim() || `curl exited with status ${result.status}`}`);
    }
    return new Uint8Array(Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""));
  }

  async headObject(input: AttachmentStorageReadInput): Promise<AttachmentStorageObjectMetadata | null> {
    const key = input.storageKey?.trim();
    if (!key) {
      return null;
    }
    try {
      const response = await this.client.headObject({
        bucket: input.storageBucket ?? this.config.bucket,
        key,
      });
      const metadata = response.data;
      return {
        provider: "tos",
        bucket: input.storageBucket ?? this.config.bucket,
        region: input.storageRegion ?? this.config.region,
        endpoint: input.storageEndpoint ?? this.config.endpoint,
        key,
        storedPath: input.storedPath,
        sizeBytes: parseContentLength(metadata["content-length"]),
        contentType: optionalString(metadata["content-type"]),
        etag: metadata.etag,
        lastModified: metadata["last-modified"],
      };
    } catch (error) {
      if (isTosNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async deleteObject(input: AttachmentStorageReadInput): Promise<void> {
    const key = input.storageKey?.trim();
    if (!key) {
      return;
    }
    await this.client.deleteObject({ bucket: input.storageBucket ?? this.config.bucket, key });
  }

  deleteObjectSync(input: AttachmentStorageReadInput): void {
    const key = input.storageKey?.trim();
    if (!key) {
      return;
    }
    const signedUrl = this.createPresignedUrl(key, "DELETE");
    const result = spawnSync("curl", [
      "-sS",
      "-o",
      "-",
      "-w",
      "\n%{http_code}",
      "-X",
      "DELETE",
      signedUrl,
    ], {
      maxBuffer: 1024 * 1024,
    });
    if (result.error) {
      throw result.error;
    }
    const output = Buffer.concat([
      Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
      Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? ""),
    ]).toString("utf8");
    if (result.status !== 0) {
      throw new Error(`TOS delete failed: ${output.trim() || `curl exited with status ${result.status}`}`);
    }
    const statusCode = parseCurlStatusCode(output);
    if (statusCode !== undefined && (statusCode === 404 || (statusCode >= 200 && statusCode < 300))) {
      return;
    }
    if (statusCode !== undefined) {
      throw new Error(`TOS delete failed with status ${statusCode}: ${output.trim()}`);
    }
  }

  async createReadUrl(input: AttachmentStorageReadInput): Promise<string | null> {
    const key = input.storageKey?.trim();
    if (!key) {
      return null;
    }
    return this.createPresignedUrl(key, "GET");
  }

  private createPresignedUrl(key: string, method: "GET" | "PUT" | "DELETE"): string {
    // The SDK runtime supports all HTTP methods; its current type declaration omits DELETE.
    return this.client.getPreSignedUrl({
      bucket: this.config.bucket,
      key,
      method: method as "GET" | "PUT",
      expires: TOS_SIGNED_URL_TTL_SECONDS,
      alternativeEndpoint: toEndpointHost(this.config.bucketDomain ?? `${this.config.bucket}.${toEndpointHost(this.config.publicEndpoint)}`),
      isCustomDomain: true,
    });
  }
}

class LocalAttachmentStorageClient implements AttachmentStorageClient {
  private readonly root: string;

  constructor(config: Extract<AttachmentRuntimeConfig, { provider: "local" }>) {
    this.root = resolve(config.local.root);
  }

  async putObject(input: AttachmentStoragePutInput): Promise<StoredAttachmentObject> {
    return this.putObjectSync(input);
  }

  putObjectSync(input: AttachmentStoragePutInput): StoredAttachmentObject {
    const key = buildAttachmentStorageKey(input);
    const targetPath = this.resolveObjectPath(key);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, input.contentBytes, { flag: "wx" });
    return this.toStoredObject(key, input.contentBytes);
  }

  async getObject(input: AttachmentStorageReadInput): Promise<Uint8Array> {
    return this.getObjectSync(input);
  }

  getObjectSync(input: AttachmentStorageReadInput): Uint8Array {
    return new Uint8Array(readFileSync(this.resolveObjectPath(this.requireStorageKey(input))));
  }

  async headObject(input: AttachmentStorageReadInput): Promise<AttachmentStorageObjectMetadata | null> {
    const key = input.storageKey?.trim();
    if (!key) return null;
    try {
      const stats = statSync(this.resolveObjectPath(key));
      return {
        provider: "local",
        key,
        storedPath: input.storedPath,
        sizeBytes: stats.size,
        lastModified: stats.mtime.toISOString(),
      };
    } catch (error) {
      if (isLocalStorageNotFoundError(error)) return null;
      throw error;
    }
  }

  async deleteObject(input: AttachmentStorageReadInput): Promise<void> {
    this.deleteObjectSync(input);
  }

  deleteObjectSync(input: AttachmentStorageReadInput): void {
    const key = input.storageKey?.trim();
    if (!key) return;
    rmSync(this.resolveObjectPath(key), { force: true });
  }

  async createReadUrl(_input: AttachmentStorageReadInput): Promise<string | null> {
    return null;
  }

  private toStoredObject(key: string, contentBytes: Uint8Array): StoredAttachmentObject {
    return {
      provider: "local",
      key,
      storedPath: `local:///${key}`,
      sizeBytes: contentBytes.byteLength,
      sha256: sha256Hex(contentBytes),
    };
  }

  private requireStorageKey(input: AttachmentStorageReadInput): string {
    const key = input.storageKey?.trim();
    if (!key) throw new Error("Missing local attachment storage key.");
    return key;
  }

  private resolveObjectPath(key: string): string {
    const targetPath = resolve(this.root, key);
    const relativePath = relative(this.root, targetPath);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      throw new Error("Attachment storage key resolves outside the configured local attachment root.");
    }
    return targetPath;
  }
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseCurlStatusCode(output: string): number | undefined {
  const match = output.match(/(\d{3})\s*$/);
  if (!match) {
    return undefined;
  }
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isTosNotFoundError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "statusCode" in error
    && Number((error as { statusCode?: unknown }).statusCode) === 404;
}

function isLocalStorageNotFoundError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function toEndpointHost(value: string): string {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  return url.host;
}

function sanitizeObjectKeySegment(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("-")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function readableToUint8Array(readable: Readable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    readable.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    readable.on("error", reject);
    readable.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
