import { createHash, randomUUID } from "node:crypto";
import {
  open as openFile,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  atomicWritePrivate,
  ensurePrivateDirectory,
  resolveConfigPaths,
} from "./config.js";
import { CliError } from "./errors.js";

export interface OperationRecord {
  operation_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  created_at: string;
  updated_at: string;
  upload_id?: string;
  layers?: string[];
  prediction_source?: "model" | "fallback";
  job_id?: string;
  resource_id?: string;
}

interface JournalDocument {
  version: 1;
  operations: Record<string, OperationRecord>;
}

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

export function newOperationId(): string {
  return `op_${randomUUID().replaceAll("-", "")}`;
}

export class OperationJournal {
  private readonly path: string;
  private readonly lockPath: string;

  constructor(path = resolveConfigPaths().operations) {
    this.path = path;
    this.lockPath = `${path}.lock`;
  }

  private async acquireLock(): Promise<void> {
    await ensurePrivateDirectory(dirname(this.path));
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      try {
        const lock = await openFile(this.lockPath, "wx", 0o600);
        try {
          await lock.writeFile(
            JSON.stringify({ pid: process.pid, created_at: Date.now() }),
          );
        } finally {
          await lock.close();
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new CliError("The Segly operation journal cannot be locked", {
            code: "operation_journal_lock_failed",
            cause: error,
          });
        }
      }

      try {
        if (Date.now() - (await stat(this.lockPath)).mtimeMs > LOCK_STALE_MS) {
          await unlink(this.lockPath);
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new CliError("The Segly operation journal lock is unreadable", {
          code: "operation_journal_lock_failed",
          cause: error,
        });
      }

      if (Date.now() >= deadline) {
        throw new CliError(
          "Another Segly process is updating the operation journal",
          { code: "operation_journal_locked", exitCode: 2 },
        );
      }
      await sleep(20 + Math.floor(Math.random() * 30));
    }
  }

  private async mutate<T>(
    operation: (journal: JournalDocument) => Promise<T>,
  ): Promise<T> {
    await this.acquireLock();
    try {
      return await operation(await this.load());
    } finally {
      await unlink(this.lockPath).catch(() => undefined);
    }
  }

  private async load(): Promise<JournalDocument> {
    try {
      const parsed = JSON.parse(
        await readFile(this.path, "utf8"),
      ) as JournalDocument;
      if (parsed.version !== 1 || !parsed.operations)
        throw new Error("unsupported journal");
      const cutoff = Date.now() - RETENTION_MS;
      parsed.operations = Object.fromEntries(
        Object.entries(parsed.operations).filter(
          ([, record]) => Date.parse(record.updated_at) >= cutoff,
        ),
      );
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, operations: {} };
      }
      throw new CliError("The Segly operation journal is unreadable", {
        code: "invalid_operation_journal",
        cause: error,
      });
    }
  }

  async open(
    operationId: string,
    requestFingerprint: string,
  ): Promise<OperationRecord> {
    return await this.mutate(async (journal) => {
      const existing = journal.operations[operationId];
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) {
          throw new CliError(
            "Operation ID was already used with different inputs",
            {
              code: "operation_conflict",
            },
          );
        }
        return existing;
      }
      const now = new Date().toISOString();
      const created: OperationRecord = {
        operation_id: operationId,
        idempotency_key: randomUUID(),
        request_fingerprint: requestFingerprint,
        created_at: now,
        updated_at: now,
      };
      journal.operations[operationId] = created;
      await atomicWritePrivate(this.path, journal);
      return created;
    });
  }

  async update(
    operationId: string,
    patch: Partial<
      Pick<
        OperationRecord,
        | "upload_id"
        | "layers"
        | "prediction_source"
        | "job_id"
        | "resource_id"
      >
    >,
  ): Promise<OperationRecord> {
    return await this.mutate(async (journal) => {
      const existing = journal.operations[operationId];
      if (!existing) {
        throw new CliError("Operation does not exist in the local journal", {
          code: "operation_not_found",
        });
      }
      const updated: OperationRecord = {
        ...existing,
        ...patch,
        updated_at: new Date().toISOString(),
      };
      journal.operations[operationId] = updated;
      await atomicWritePrivate(this.path, journal);
      return updated;
    });
  }

  async get(operationId: string): Promise<OperationRecord | undefined> {
    return (await this.load()).operations[operationId];
  }
}
