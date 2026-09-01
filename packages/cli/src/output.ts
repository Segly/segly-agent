import { normalizeError, redact } from "./errors.js";

export interface OutputWriter {
  result(value: unknown): void;
  progress(message: string): void;
  failure(error: unknown): number;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (
      /(?:^|_)(?:api_?key|access_?token|refresh_?token|recovery_?secret|payment_?credential|secret|file_?name|filename)$/iu.test(
        key,
      )
    ) {
      return "[REDACTED]";
    }
    if (typeof item === "string") return redact(item);
    return item;
  });
}

export function createOutputWriter(
  stdout: NodeJS.WritableStream = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
): OutputWriter {
  return {
    result(value: unknown) {
      stdout.write(`${safeJson(value)}\n`);
    },
    progress(message: string) {
      stderr.write(`segly: ${redact(message)}\n`);
    },
    failure(error: unknown) {
      const normalized = normalizeError(error);
      stdout.write(
        `${safeJson({
          error: {
            code: normalized.code,
            message: normalized.message,
            ...(normalized.details ? { details: normalized.details } : {}),
          },
        })}\n`,
      );
      return normalized.exitCode;
    },
  };
}
