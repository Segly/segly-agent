import type { ProblemDetails } from "./types.js";

const SECRET_PATTERNS = [
  /sgly_(?:live|test)_[A-Za-z0-9_-]+/gu,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
  /https?:\/\/\S*[?&](?:signature|sig|token|x-amz-signature|x-goog-signature|x-ms-signature)=[^\s&]+\S*/giu,
];

export function redact(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  );
}

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    message: string,
    options: {
      code?: string;
      exitCode?: number;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(redact(message), { cause: options.cause });
    this.name = "CliError";
    this.code = options.code ?? "cli_error";
    this.exitCode = options.exitCode ?? 1;
    this.details = options.details;
  }
}

export class ApiError extends CliError {
  readonly status: number;
  readonly problem: ProblemDetails;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, problem: ProblemDetails, retryAfterMs?: number) {
    super(
      problem.detail ?? problem.title ?? `Segly API returned HTTP ${status}`,
      {
        code: problem.code ?? "api_error",
        exitCode:
          status === 401 ? 3 : status === 402 ? 4 : status === 429 ? 5 : 2,
        details: {
          status,
          request_id: problem.request_id,
          retryable: problem.retryable ?? false,
        },
      },
    );
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
    this.retryAfterMs = retryAfterMs;
  }
}

export function normalizeError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error) {
    return new CliError(error.message, {
      code: "unexpected_error",
      cause: error,
    });
  }
  return new CliError("Unexpected error", { code: "unexpected_error" });
}
