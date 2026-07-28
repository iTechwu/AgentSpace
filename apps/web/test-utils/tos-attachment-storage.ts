import { createHash } from "node:crypto";
import type {
  AttachmentStorageClient,
  AttachmentStoragePutInput,
  AttachmentStorageReadInput,
  StoredAttachmentObject,
} from "@dofe-agent/services";

export function createTestTosAttachmentStorage(): {
  client: AttachmentStorageClient;
  clear: () => void;
  seed: (key: string, content: string | Uint8Array) => void;
} {
  const objects = new Map<string, Uint8Array>();
  const readKey = (input: AttachmentStorageReadInput) => input.storageKey?.trim() ?? "";
  const metadata = (key: string, bytes: Uint8Array): StoredAttachmentObject => ({
    provider: "tos",
    bucket: "test-bucket",
    region: "cn-beijing",
    endpoint: "https://tos-cn-beijing.volces.com",
    key,
    storedPath: `tos://test-bucket/${key}`,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });

  const client: AttachmentStorageClient = {
    async putObject(input: AttachmentStoragePutInput) {
      return this.putObjectSync(input);
    },
    putObjectSync(input: AttachmentStoragePutInput) {
      const key = `workspaces/${input.workspaceId}/attachments/${input.attachmentId}/${input.fileName}`;
      const bytes = new Uint8Array(input.contentBytes);
      objects.set(key, bytes);
      return metadata(key, bytes);
    },
    async getObject(input: AttachmentStorageReadInput) {
      return this.getObjectSync(input);
    },
    getObjectSync(input: AttachmentStorageReadInput) {
      const key = readKey(input);
      const content = objects.get(key);
      if (!content) {
        throw new Error(`NoSuchKey: ${key}`);
      }
      return new Uint8Array(content);
    },
    async headObject(input: AttachmentStorageReadInput) {
      const key = readKey(input);
      const content = objects.get(key);
      return content ? metadata(key, content) : null;
    },
    async deleteObject(input: AttachmentStorageReadInput) {
      objects.delete(readKey(input));
    },
    deleteObjectSync(input: AttachmentStorageReadInput) {
      objects.delete(readKey(input));
    },
    async createReadUrl(input: AttachmentStorageReadInput) {
      const key = readKey(input);
      return key ? `https://test-bucket.example.com/${key}` : null;
    },
  };

  return {
    client,
    clear: () => objects.clear(),
    seed: (key, content) => {
      objects.set(key, typeof content === "string" ? Buffer.from(content, "utf8") : new Uint8Array(content));
    },
  };
}
