import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { McpToolAuditReport } from "../daemon-api.ts";
import { ensureDaemonStateDir } from "../state.ts";

const OUTBOX_DIR = "mcp-audit-outbox";
const DEAD_LETTER_DIR = "dead-letter";
const MAX_FLUSH_ITEMS = 500;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface McpAuditOutboxItem {
  version: 1;
  audit: McpToolAuditReport;
  queuedAt: string;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
}

export interface McpAuditReporter {
  reportMcpToolAudits(taskId: string, audits: McpToolAuditReport[]): Promise<void>;
}

export interface McpAuditOutboxFlushResult {
  attempted: number;
  delivered: number;
  failed: number;
  deadLettered: number;
}

export class McpAuditOutbox {
  private readonly rootDir: string;
  private readonly deadLetterDir: string;
  private readonly maxAgeMs: number;
  private flushing = false;

  constructor(stateDir: string, options: { maxAgeMs?: number } = {}) {
    this.rootDir = join(ensureDaemonStateDir(stateDir), OUTBOX_DIR);
    this.deadLetterDir = join(this.rootDir, DEAD_LETTER_DIR);
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.deadLetterDir, { recursive: true, mode: 0o700 });
  }

  enqueue(audit: McpToolAuditReport): void {
    assertAudit(audit);
    const targetPath = this.pathForEvent(audit.eventId);
    if (existsSync(targetPath)) return;

    const item: McpAuditOutboxItem = {
      version: 1,
      audit: { ...audit },
      queuedAt: new Date().toISOString(),
      attempts: 0,
    };
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(item), { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      // link(2) fails with EEXIST and never overwrites another process's event.
      linkSync(temporaryPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }

  async flush(reporter: McpAuditReporter): Promise<McpAuditOutboxFlushResult> {
    if (this.flushing) {
      return { attempted: 0, delivered: 0, failed: 0, deadLettered: 0 };
    }
    this.flushing = true;
    const result: McpAuditOutboxFlushResult = {
      attempted: 0,
      delivered: 0,
      failed: 0,
      deadLettered: 0,
    };
    try {
      const names = readdirSync(this.rootDir)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .slice(0, MAX_FLUSH_ITEMS);
      for (const name of names) {
        const path = join(this.rootDir, name);
        const item = this.readItem(path);
        if (!item) {
          this.moveToDeadLetter(path, name);
          result.deadLettered += 1;
          continue;
        }
        if (Date.now() - new Date(item.queuedAt).getTime() > this.maxAgeMs) {
          this.moveToDeadLetter(path, name);
          result.deadLettered += 1;
          continue;
        }

        result.attempted += 1;
        try {
          await reporter.reportMcpToolAudits(item.audit.taskId, [item.audit]);
          rmSync(path, { force: true });
          result.delivered += 1;
        } catch (error) {
          const updated: McpAuditOutboxItem = {
            ...item,
            attempts: item.attempts + 1,
            lastAttemptAt: new Date().toISOString(),
            lastError: sanitizeError(error),
          };
          this.replaceItem(path, updated);
          result.failed += 1;
        }
      }
      return result;
    } finally {
      this.flushing = false;
    }
  }

  private pathForEvent(eventId: string): string {
    const digest = createHash("sha256").update(eventId).digest("hex");
    return join(this.rootDir, `${digest}.json`);
  }

  private readItem(path: string): McpAuditOutboxItem | null {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Partial<McpAuditOutboxItem>;
      if (value.version !== 1 || typeof value.queuedAt !== "string" || typeof value.attempts !== "number") {
        return null;
      }
      assertAudit(value.audit);
      return value as McpAuditOutboxItem;
    } catch {
      return null;
    }
  }

  private replaceItem(path: string, item: McpAuditOutboxItem): void {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(item), { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, path);
  }

  private moveToDeadLetter(path: string, name: string): void {
    renameSync(path, join(this.deadLetterDir, `${Date.now()}-${name}`));
  }
}

function assertAudit(value: unknown): asserts value is McpToolAuditReport {
  if (!value || typeof value !== "object") throw new Error("MCP audit is invalid.");
  const audit = value as Partial<McpToolAuditReport>;
  if (
    typeof audit.taskId !== "string" || !audit.taskId ||
    typeof audit.connectionId !== "string" || !audit.connectionId ||
    typeof audit.toolName !== "string" || !audit.toolName ||
    (audit.outcome !== "succeeded" && audit.outcome !== "failed") ||
    typeof audit.eventId !== "string" || !audit.eventId
  ) {
    throw new Error("MCP audit is invalid.");
  }
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}
