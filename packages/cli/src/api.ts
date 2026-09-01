import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ApiError, CliError } from "./errors.js";
import { resolveCredential, resolveCredentialIdentity } from "./config.js";
import type { JsonValue, ProblemDetails } from "./types.js";

export interface ApiClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
  apiKey?: string;
  fetchImplementation?: typeof fetch;
  sleepImplementation?: (delayMs: number) => Promise<void>;
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  authenticated?: boolean;
  retryable?: boolean;
  onResponse?: (metadata: { retryAfterMs: number | undefined }) => void;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function problemFrom(value: unknown, status: number): ProblemDetails {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const problem = { ...(value as ProblemDetails), status };
    if (typeof problem.retryable !== "boolean") {
      problem.retryable = isRetryableStatus(status);
    }
    return problem;
  }
  return {
    type: "about:blank",
    title: "Segly API request failed",
    status,
    code: "api_error",
    retryable: isRetryableStatus(status),
  };
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly apiKey: string | undefined;
  private readonly fetchImplementation: typeof fetch;
  private readonly sleepImplementation: (delayMs: number) => Promise<void>;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.apiKey = options.apiKey;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.sleepImplementation = options.sleepImplementation ?? sleep;
  }

  async credentialFingerprint(): Promise<string> {
    if (this.apiKey)
      return createHash("sha256").update(this.apiKey).digest("hex");
    return await resolveCredentialIdentity();
  }

  async get<T extends JsonValue>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    return await this.request<T>("GET", path, { ...options, retryable: true });
  }

  async post<T extends JsonValue>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    return await this.request<T>("POST", path, options);
  }

  async delete<T extends JsonValue>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    return await this.request<T>("DELETE", path, {
      ...options,
      retryable: true,
    });
  }

  async request<T extends JsonValue>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const headers = new Headers(options.headers);
    if (options.body !== undefined)
      headers.set("content-type", "application/json");
    if (options.authenticated !== false) {
      const apiKey = this.apiKey ?? (await resolveCredential()).apiKey;
      headers.set("authorization", `Bearer ${apiKey}`);
    }

    const attempts = options.retryable ? this.maxRetries + 1 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const init: RequestInit = {
          method,
          headers,
          signal: controller.signal,
        };
        if (options.body !== undefined)
          init.body = JSON.stringify(options.body);
        const response = await this.fetchImplementation(
          new URL(path, `${this.baseUrl}/`),
          init,
        );
        const retryAfterMs = parseRetryAfter(
          response.headers.get("retry-after"),
        );
        const text = await response.text();
        const parsed = text ? (JSON.parse(text) as unknown) : null;
        if (response.ok) {
          options.onResponse?.({ retryAfterMs });
          return parsed as T;
        }

        const problem = problemFrom(parsed, response.status);
        const error = new ApiError(response.status, problem, retryAfterMs);
        if (
          !options.retryable ||
          !isRetryableStatus(response.status) ||
          problem.retryable !== true ||
          attempt + 1 >= attempts
        ) {
          throw error;
        }
        lastError = error;
        await this.sleepImplementation(
          retryAfterMs ?? Math.min(500 * 2 ** attempt, 10_000),
        );
      } catch (error) {
        if (error instanceof ApiError) throw error;
        lastError = error;
        if (!options.retryable || attempt + 1 >= attempts) {
          const timedOut =
            error instanceof Error && error.name === "AbortError";
          throw new CliError(
            timedOut
              ? "Segly API request timed out"
              : "Could not reach the Segly API",
            {
              code: timedOut ? "request_timeout" : "network_error",
              exitCode: 2,
              cause: error,
            },
          );
        }
        await this.sleepImplementation(Math.min(500 * 2 ** attempt, 10_000));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  async putSigned(
    url: string,
    bytes: Uint8Array,
    headers: Record<string, string>,
  ): Promise<void> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImplementation(url, {
          method: "PUT",
          headers,
          body: bytes as unknown as BodyInit,
          signal: controller.signal,
        });
        if (response.ok) return;
        const responseProblem = await response
          .clone()
          .json()
          .catch(() => null);
        const retryable =
          isRetryableStatus(response.status) &&
          problemFrom(responseProblem, response.status).retryable === true;
        if (!retryable || attempt >= this.maxRetries) {
          throw new CliError("The private upload failed", {
            code: "upload_failed",
            exitCode: 2,
            details: { status: response.status },
          });
        }
        await response.body?.cancel();
        await this.sleepImplementation(
          parseRetryAfter(response.headers.get("retry-after")) ??
            Math.min(500 * 2 ** attempt, 10_000),
        );
      } catch (error) {
        if (error instanceof CliError || attempt >= this.maxRetries)
          throw error;
        await this.sleepImplementation(Math.min(500 * 2 ** attempt, 10_000));
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  async getSigned(url: string): Promise<Response> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImplementation(url, {
          signal: controller.signal,
        });
        if (response.ok) return response;
        const responseProblem = await response
          .clone()
          .json()
          .catch(() => null);
        const retryable =
          isRetryableStatus(response.status) &&
          problemFrom(responseProblem, response.status).retryable === true;
        if (!retryable || attempt >= this.maxRetries) {
          throw new CliError("Artifact download failed", {
            code: "download_failed",
            exitCode: 2,
            details: { status: response.status },
          });
        }
        await response.body?.cancel();
        await this.sleepImplementation(
          parseRetryAfter(response.headers.get("retry-after")) ??
            Math.min(500 * 2 ** attempt, 10_000),
        );
      } catch (error) {
        if (error instanceof CliError || attempt >= this.maxRetries)
          throw error;
        await this.sleepImplementation(Math.min(500 * 2 ** attempt, 10_000));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new CliError("Artifact download failed", {
      code: "download_failed",
      exitCode: 2,
    });
  }
}

export { parseRetryAfter };
