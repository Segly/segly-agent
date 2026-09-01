import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { CliError } from "./errors.js";
import { storeOAuthCredential } from "./config.js";

interface ProtectedResourceMetadata {
  authorization_servers?: string[];
}

interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface OAuthLoginResult {
  available: boolean;
  authenticated?: boolean;
  credential_store?: "secret-service" | "windows-dpapi" | "file";
  expires_at?: string;
  authorization_server?: string;
  reason?: string;
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

async function fetchJson<T>(
  url: URL,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<{
  response: Response;
  value: T | undefined;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let value: T | undefined;
    if (text) {
      try {
        value = JSON.parse(text) as T;
      } catch {
        throw new CliError("OAuth server returned invalid JSON", {
          code: "invalid_oauth_response",
        });
      }
    }
    return { response, value };
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverAuthorizationMetadata(
  issuer: URL,
  timeoutMs: number,
): Promise<AuthorizationServerMetadata | undefined> {
  const candidates = [
    new URL(
      `${issuer.toString().replace(/\/$/u, "")}/.well-known/oauth-authorization-server`,
    ),
    new URL(
      `/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/u, "")}`,
      issuer.origin,
    ),
  ];
  for (const candidate of candidates) {
    const { response, value } = await fetchJson<AuthorizationServerMetadata>(
      candidate,
      {},
      timeoutMs,
    );
    if (response.ok && value) return value;
    if (response.status !== 404) {
      throw new CliError("OAuth authorization-server discovery failed", {
        code: "oauth_discovery_failed",
        details: { status: response.status },
      });
    }
  }
  return undefined;
}

function openBrowser(url: string): boolean {
  const command =
    process.platform === "darwin"
      ? { executable: "open", args: [url] }
      : process.platform === "win32"
        ? { executable: "explorer.exe", args: [url] }
        : { executable: "xdg-open", args: [url] };
  try {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

interface CallbackServer {
  redirectUri: string;
  waitForCode: Promise<string>;
  server: Server;
  cancel: () => void;
}

async function startCallbackServer(
  state: string,
  timeoutMs: number,
): Promise<CallbackServer> {
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const returnedState = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (error || returnedState !== state || !code) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Segly authorization failed. You can close this window.");
      rejectCode(
        new CliError(
          error
            ? `OAuth authorization failed: ${error}`
            : "OAuth callback was invalid",
          {
            code: "oauth_callback_failed",
          },
        ),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("Segly authorization complete. You can close this window.");
    resolveCode(code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new CliError("Could not start the OAuth callback listener", {
      code: "oauth_callback_failed",
    });
  }
  const timer = setTimeout(
    () =>
      rejectCode(
        new CliError("OAuth login timed out", {
          code: "oauth_timeout",
          exitCode: 2,
        }),
      ),
    timeoutMs,
  );
  timer.unref();
  void waitForCode.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  );
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    waitForCode,
    server,
    cancel: () => resolveCode(""),
  };
}

export async function loginWithOAuth(options: {
  apiUrl: string;
  timeoutMs?: number;
  open?: boolean;
  progress?: (message: string) => void;
}): Promise<OAuthLoginResult> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const resourceUrl = new URL(
    "/.well-known/oauth-protected-resource/v1",
    options.apiUrl,
  );
  const resource = await fetchJson<ProtectedResourceMetadata>(
    resourceUrl,
    {},
    Math.min(timeoutMs, 30_000),
  );
  if (
    resource.response.status === 404 ||
    !resource.value?.authorization_servers?.length
  ) {
    return { available: false, reason: "oauth_not_enabled" };
  }
  if (!resource.response.ok) {
    throw new CliError("OAuth protected-resource discovery failed", {
      code: "oauth_discovery_failed",
      details: { status: resource.response.status },
    });
  }
  const issuerValue = resource.value.authorization_servers[0];
  if (!issuerValue) return { available: false, reason: "oauth_not_enabled" };
  const issuer = new URL(issuerValue);
  if (
    issuer.protocol !== "https:" &&
    issuer.hostname !== "localhost" &&
    issuer.hostname !== "127.0.0.1"
  ) {
    throw new CliError("OAuth authorization server must use HTTPS", {
      code: "insecure_oauth_endpoint",
    });
  }
  const metadata = await discoverAuthorizationMetadata(
    issuer,
    Math.min(timeoutMs, 30_000),
  );
  if (!metadata?.authorization_endpoint || !metadata.token_endpoint) {
    return {
      available: false,
      authorization_server: issuer.toString(),
      reason: "oauth_not_enabled",
    };
  }
  if (!process.env.SEGLY_OAUTH_CLIENT_ID && !metadata.registration_endpoint) {
    return {
      available: false,
      authorization_server: issuer.toString(),
      reason: "dynamic_client_registration_unavailable",
    };
  }

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(24));
  const callback = await startCallbackServer(state, timeoutMs);
  try {
    let clientId = process.env.SEGLY_OAUTH_CLIENT_ID;
    if (!clientId) {
      if (!metadata.registration_endpoint) {
        return {
          available: false,
          authorization_server: issuer.toString(),
          reason: "dynamic_client_registration_unavailable",
        };
      }
      const registration = await fetchJson<Record<string, unknown>>(
        new URL(metadata.registration_endpoint),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "Segly CLI",
            redirect_uris: [callback.redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        },
        Math.min(timeoutMs, 30_000),
      );
      if (
        !registration.response.ok ||
        typeof registration.value?.client_id !== "string"
      ) {
        throw new CliError("OAuth dynamic client registration failed", {
          code: "oauth_registration_failed",
          details: { status: registration.response.status },
        });
      }
      clientId = registration.value.client_id;
    }

    const desiredScopes = ["openid", "profile", "email", "offline_access"];
    const scopes = metadata.scopes_supported?.length
      ? desiredScopes.filter((scope) =>
          metadata.scopes_supported?.includes(scope),
        )
      : desiredScopes;
    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: callback.redirectUri,
      scope: scopes.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    if (options.open !== false && openBrowser(authorizationUrl.toString())) {
      options.progress?.("opened the Segly authorization page in your browser");
    } else {
      options.progress?.(
        `open this authorization URL: ${authorizationUrl.toString()}`,
      );
    }
    const code = await callback.waitForCode;
    const token = await fetchJson<OAuthTokenResponse>(
      new URL(metadata.token_endpoint),
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: callback.redirectUri,
          client_id: clientId,
          code_verifier: verifier,
        }),
      },
      Math.min(timeoutMs, 30_000),
    );
    if (
      !token.response.ok ||
      !token.value?.access_token ||
      !token.value.refresh_token
    ) {
      throw new CliError("OAuth token exchange failed", {
        code: "oauth_token_exchange_failed",
        details: { status: token.response.status },
      });
    }
    const expiresAt = new Date(
      Date.now() + (token.value.expires_in ?? 3600) * 1000,
    ).toISOString();
    const store = await storeOAuthCredential({
      access_token: token.value.access_token,
      refresh_token: token.value.refresh_token,
      expires_at: expiresAt,
      token_endpoint: metadata.token_endpoint,
      client_id: clientId,
      credential_id: randomUUID(),
    });
    return {
      available: true,
      authenticated: true,
      credential_store: store,
      expires_at: expiresAt,
      authorization_server: issuer.toString(),
    };
  } finally {
    callback.cancel();
    callback.server.close();
  }
}
