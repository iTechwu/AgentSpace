// attachment Phase 2 真 Prisma Client primary：与前 11 域同款。
// 复用 prisma-client.ts 共享单例。

import type { PrismaClient } from "@prisma/client";
import {
  disconnectDofePrismaClient,
  getDofePrismaClient,
  setDofePrismaClientForTests,
} from "./prisma-client.ts";
import type { StoredAttachmentRecord } from "../attachments.ts";

interface PrismaAttachment {
  id: string;
  workspaceId: string;
  messageId: string | null;
  channelName: string | null;
  speaker: string;
  role: string;
  fileName: string;
  mediaType: string | null;
  sizeBytes: number | null;
  contentDigest: string | null;
  storedPath: string;
  storageProvider: string | null;
  storageBucket: string | null;
  storageRegion: string | null;
  storageEndpoint: string | null;
  storageKey: string | null;
  storageUrl: string | null;
  note: string | null;
  uploadId: string | null;
  sourceMessageIndex: number;
  sourceMessageTime: Date | null;
  sourceSummary: string | null;
  deletedAt: Date | null;
  deletedByUserId: string | null;
  deletedByDisplayName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function listStoredAttachmentsPrisma(
  workspaceId: string = "default",
  client?: PrismaClient,
): Promise<StoredAttachmentRecord[]> {
  const prisma = client ?? getDofePrismaClient();
  const rows = await prisma.attachment.findMany({
    where: { workspaceId },
    orderBy: [{ sourceMessageIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => mapPrismaRow(row as unknown as PrismaAttachment));
}

export function isAttachmentsPrismaReadEnabled(): boolean {
  return process.env.ATTACHMENTS_PRISMA_READ_ENABLED === "1";
}

export function isAttachmentsPrismaShadowReadEnabled(): boolean {
  return process.env.ATTACHMENTS_PRISMA_SHADOW_READ_ENABLED === "1";
}

export { setDofePrismaClientForTests as setAttachmentsPrismaClientForTests };

export async function disconnectAttachmentsPrismaForTests(): Promise<void> {
  await disconnectDofePrismaClient();
}

function mapPrismaRow(row: PrismaAttachment): StoredAttachmentRecord {
  const record: StoredAttachmentRecord = {
    id: row.id,
    workspaceId: row.workspaceId,
    fileName: row.fileName,
    mediaType: row.mediaType ?? "application/octet-stream",
    sizeBytes: row.sizeBytes ?? 0,
    kind: "file",
    storedPath: row.storedPath,
    speaker: row.speaker,
    role: row.role,
    sourceMessageIndex: row.sourceMessageIndex,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.messageId !== null) record.messageId = row.messageId;
  if (row.channelName !== null) record.channelName = row.channelName;
  if (row.contentDigest !== null) record.sha256 = row.contentDigest;
  if (row.storageProvider !== null) {
    const provider = row.storageProvider;
    if (provider === "tos" || provider === "local") {
      record.storageProvider = provider;
    }
  }
  if (row.storageBucket !== null) record.storageBucket = row.storageBucket;
  if (row.storageRegion !== null) record.storageRegion = row.storageRegion;
  if (row.storageEndpoint !== null) record.storageEndpoint = row.storageEndpoint;
  if (row.storageKey !== null) record.storageKey = row.storageKey;
  if (row.storageUrl !== null) record.storageUrl = row.storageUrl;
  if (row.sourceMessageTime) record.sourceMessageTime = row.sourceMessageTime.toISOString();
  if (row.sourceSummary !== null) record.sourceSummary = row.sourceSummary;
  if (row.deletedAt) record.deletedAt = row.deletedAt.toISOString();
  if (row.deletedByUserId !== null) record.deletedByUserId = row.deletedByUserId;
  if (row.deletedByDisplayName !== null) record.deletedByDisplayName = row.deletedByDisplayName;
  return record;
}