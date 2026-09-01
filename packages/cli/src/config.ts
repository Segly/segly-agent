import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CliError } from "./errors.js";

export const DEFAULT_API_URL = "https://api.segly.io";

interface ConfigMetadata {
  api_url?: string;
  credential_store?: "secret-tool" | "windows-dpapi" | "file";
}

export interface OAuthCredential {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  token_endpoint: string;
  client_id: string;
  credential_id: string;
}

interface StoredCredentialFile {
  api_key?: string;
  oauth?: OAuthCredential;
}

interface WindowsDpapiEnvelope {
  scheme: "windows-dpapi";
  ciphertext: string;
}

type CredentialStore = "secret-service" | "windows-dpapi" | "file";

export interface CredentialResolution {
  apiKey: string;
  source: "environment" | CredentialStore;
}

export interface ConfigPaths {
  directory: string;
  config: string;
  credentials: string;
  operations: string;
  recovery: string;
  webhooks: string;
}

export function resolveConfigPaths(): ConfigPaths {
  const override = process.env.SEGLY_CONFIG_DIR;
  let directory: string;
  if (override) {
    directory = override;
  } else if (process.platform === "win32") {
    directory = join(process.env.APPDATA ?? homedir(), "Segly");
  } else if (process.platform === "darwin") {
    directory = join(homedir(), "Library", "Application Support", "Segly");
  } else {
    directory = join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "segly",
    );
  }
  return {
    directory,
    config: join(directory, "config.json"),
    credentials: join(directory, "credentials.json"),
    operations: join(directory, "operations.json"),
    recovery: join(directory, "recovery.json"),
    webhooks: join(directory, "webhooks.json"),
  };
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
}

export async function atomicWritePrivate(
  path: string,
  value: unknown,
): Promise<void> {
  const directory = path.slice(
    0,
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")),
  );
  if (directory) await ensurePrivateDirectory(directory);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
    if (
      process.platform !== "win32" &&
      ((await stat(path)).mode & 0o077) !== 0
    ) {
      await unlink(path).catch(() => undefined);
      throw new CliError(
        "The selected filesystem cannot enforce private credential permissions",
        {
          code: "insecure_config_filesystem",
        },
      );
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new CliError("Segly configuration is unreadable", {
      code: "invalid_configuration",
      cause: error,
    });
  }
}

async function runSecretTool(
  args: string[],
  input?: string,
): Promise<{ ok: boolean; stdout: string }> {
  return await new Promise((resolve) => {
    const child = spawn("secret-tool", args, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve({ ok: false, stdout: "" }));
    child.on("close", (code) =>
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(chunks).toString("utf8"),
      }),
    );
    child.stdin.end(input);
  });
}

async function runPowerShell(
  script: string,
  input: string,
): Promise<{ ok: boolean; stdout: string }> {
  return await new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve({ ok: false, stdout: "" }));
    child.on("close", (code) =>
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(chunks).toString("utf8"),
      }),
    );
    child.stdin.end(input);
  });
}

async function protectWithWindowsDpapi(value: string): Promise<string> {
  const result = await runPowerShell(
    [
      "$encoded = [Console]::In.ReadToEnd()",
      "$plain = [Convert]::FromBase64String($encoded)",
      "$cipher = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[Console]::Out.Write([Convert]::ToBase64String($cipher))",
    ].join("; "),
    Buffer.from(value, "utf8").toString("base64"),
  );
  const ciphertext = result.stdout.trim();
  if (!result.ok || !ciphertext) {
    throw new CliError(
      "Windows could not protect the Segly credential for the current user",
      { code: "secure_credential_store_unavailable" },
    );
  }
  return ciphertext;
}

async function unprotectWithWindowsDpapi(ciphertext: string): Promise<string> {
  const result = await runPowerShell(
    [
      "$encoded = [Console]::In.ReadToEnd()",
      "$cipher = [Convert]::FromBase64String($encoded)",
      "$plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))",
    ].join("; "),
    ciphertext,
  );
  if (!result.ok) {
    throw new CliError(
      "The Segly credential cannot be decrypted by the current Windows user",
      { code: "invalid_configuration" },
    );
  }
  return result.stdout;
}

function isWindowsDpapiEnvelope(
  value: unknown,
): value is WindowsDpapiEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.scheme === "windows-dpapi" &&
    typeof candidate.ciphertext === "string" &&
    candidate.ciphertext.length > 0
  );
}

async function writeSecretFile(path: string, value: unknown): Promise<CredentialStore> {
  if (process.platform === "win32") {
    const ciphertext = await protectWithWindowsDpapi(JSON.stringify(value));
    await atomicWritePrivate(path, {
      scheme: "windows-dpapi",
      ciphertext,
    } satisfies WindowsDpapiEnvelope);
    return "windows-dpapi";
  }
  await atomicWritePrivate(path, value);
  return "file";
}

async function readSecretFile<T>(path: string): Promise<T | undefined> {
  const raw = await readJson<unknown>(path);
  if (raw === undefined) return undefined;
  if (isWindowsDpapiEnvelope(raw)) {
    if (process.platform !== "win32") {
      throw new CliError(
        "This Segly credential is protected for a Windows user",
        { code: "invalid_configuration" },
      );
    }
    try {
      return JSON.parse(
        await unprotectWithWindowsDpapi(raw.ciphertext),
      ) as T;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("Segly protected credential data is invalid", {
        code: "invalid_configuration",
        cause: error,
      });
    }
  }
  if (process.platform === "win32") {
    throw new CliError(
      "A legacy plaintext Segly credential file was found on Windows; remove it and authenticate again",
      { code: "insecure_credential_file" },
    );
  }
  return raw as T;
}

async function secretToolAvailable(): Promise<boolean> {
  if (
    process.platform !== "linux" ||
    process.env.SEGLY_DISABLE_KEYCHAIN === "1"
  ) {
    return false;
  }
  const result = await runSecretTool(["--version"]);
  return result.ok;
}

async function readMetadata(): Promise<ConfigMetadata> {
  return (await readJson<ConfigMetadata>(resolveConfigPaths().config)) ?? {};
}

function parseStoredCredential(
  value: string,
): StoredCredentialFile | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("sgly_")) return { api_key: trimmed };
  try {
    const parsed = JSON.parse(trimmed) as StoredCredentialFile;
    if (parsed.api_key || parsed.oauth) return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

async function refreshOAuthCredential(
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  if (Date.parse(credential.expires_at) > Date.now() + 60_000)
    return credential;
  const endpoint = new URL(credential.token_endpoint);
  if (
    endpoint.protocol !== "https:" &&
    endpoint.hostname !== "127.0.0.1" &&
    endpoint.hostname !== "localhost"
  ) {
    throw new CliError("OAuth token endpoint must use HTTPS", {
      code: "insecure_oauth_endpoint",
    });
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh_token,
      client_id: credential.client_id,
    }),
  });
  if (!response.ok) {
    throw new CliError(
      "Segly OAuth session expired; run `segly auth login` again",
      {
        code: "oauth_refresh_failed",
        exitCode: 3,
      },
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  if (typeof payload.access_token !== "string") {
    throw new CliError("OAuth token response is invalid", {
      code: "invalid_oauth_response",
    });
  }
  const expiresIn =
    typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  return {
    ...credential,
    access_token: payload.access_token,
    refresh_token:
      typeof payload.refresh_token === "string"
        ? payload.refresh_token
        : credential.refresh_token,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

async function storeMainSecret(
  value: string,
  fallback: StoredCredentialFile,
): Promise<CredentialStore> {
  const metadata = await readMetadata();
  if (await secretToolAvailable()) {
    const result = await runSecretTool(
      [
        "store",
        "--label=Segly credential",
        "service",
        "segly",
        "account",
        "default",
      ],
      value,
    );
    if (result.ok) {
      await unlink(resolveConfigPaths().credentials).catch(() => undefined);
      await writeMetadata({ ...metadata, credential_store: "secret-tool" });
      return "secret-service";
    }
  }
  const store = await writeSecretFile(resolveConfigPaths().credentials, fallback);
  await writeMetadata({
    ...metadata,
    credential_store: store === "windows-dpapi" ? store : "file",
  });
  return store;
}

async function writeMetadata(metadata: ConfigMetadata): Promise<void> {
  await atomicWritePrivate(resolveConfigPaths().config, metadata);
}

export async function resolveApiUrl(override?: string): Promise<string> {
  const metadata = await readMetadata();
  const candidate =
    override ??
    process.env.SEGLY_API_URL ??
    metadata.api_url ??
    DEFAULT_API_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new CliError("Segly API URL is invalid", { code: "invalid_api_url" });
  }
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1"
  ) {
    throw new CliError("Segly API URL must use HTTPS", {
      code: "insecure_api_url",
    });
  }
  return url.toString().replace(/\/$/u, "");
}

export async function storeApiKey(
  apiKey: string,
): Promise<CredentialStore> {
  const key = apiKey.trim();
  if (!/^sgly_(?:live|test)_[A-Za-z0-9_-]{24,}$/u.test(key)) {
    throw new CliError("The provided value is not a valid Segly API key", {
      code: "invalid_api_key",
    });
  }

  return await storeMainSecret(key, { api_key: key });
}

export async function storeOAuthCredential(
  credential: OAuthCredential,
): Promise<CredentialStore> {
  return await storeMainSecret(JSON.stringify({ oauth: credential }), {
    oauth: credential,
  });
}

export async function resolveCredential(): Promise<CredentialResolution> {
  const environmentKey = process.env.SEGLY_API_KEY?.trim();
  if (environmentKey) return { apiKey: environmentKey, source: "environment" };

  const { stored, source } = await loadStoredCredential();
  const key = stored?.api_key?.trim();
  if (key) return { apiKey: key, source };
  if (stored?.oauth) {
    const refreshed = await refreshOAuthCredential(stored.oauth);
    if (refreshed.access_token !== stored.oauth.access_token) {
      await storeOAuthCredential(refreshed);
    }
    return { apiKey: refreshed.access_token, source };
  }
  throw new CliError("No Segly API key is configured", {
    code: "authentication_required",
    exitCode: 3,
  });
}

async function loadStoredCredential(): Promise<{
  stored: StoredCredentialFile | undefined;
  source: CredentialResolution["source"];
}> {
  const metadata = await readMetadata();
  let stored: StoredCredentialFile | undefined;
  let source: CredentialResolution["source"] = "file";
  if (
    metadata.credential_store !== "file" &&
    (metadata.credential_store === "secret-tool" ||
      (await secretToolAvailable()))
  ) {
    const result = await runSecretTool([
      "lookup",
      "service",
      "segly",
      "account",
      "default",
    ]);
    if (result.ok) {
      stored = parseStoredCredential(result.stdout);
      source = "secret-service";
    }
  }
  stored ??= await readSecretFile<StoredCredentialFile>(
    resolveConfigPaths().credentials,
  );
  return { stored, source };
}

export async function resolveCredentialIdentity(): Promise<string> {
  const environmentKey = process.env.SEGLY_API_KEY?.trim();
  if (environmentKey)
    return createHash("sha256").update(environmentKey).digest("hex");
  const { stored } = await loadStoredCredential();
  if (stored?.api_key)
    return createHash("sha256").update(stored.api_key).digest("hex");
  if (stored?.oauth) return stored.oauth.credential_id;
  throw new CliError("No Segly API key is configured", {
    code: "authentication_required",
    exitCode: 3,
  });
}

async function readRecoveryFile(): Promise<Record<string, string>> {
  return (
    (await readSecretFile<Record<string, string>>(
      resolveConfigPaths().recovery,
    )) ??
    {}
  );
}

async function writeSecretMap(
  path: string,
  value: Record<string, string>,
): Promise<CredentialStore> {
  return await writeSecretFile(path, value);
}

export async function storeRecoverySecret(
  id: string,
  secret: string,
): Promise<CredentialStore> {
  if (await secretToolAvailable()) {
    const result = await runSecretTool(
      [
        "store",
        "--label=Segly recovery secret",
        "service",
        "segly",
        "account",
        `recovery:${id}`,
      ],
      secret,
    );
    if (result.ok) {
      const recovery = await readRecoveryFile();
      if (recovery[id] !== undefined) {
        delete recovery[id];
        await writeSecretMap(resolveConfigPaths().recovery, recovery);
      }
      return "secret-service";
    }
  }
  const recovery = await readRecoveryFile();
  recovery[id] = secret;
  return await writeSecretMap(resolveConfigPaths().recovery, recovery);
}

export async function resolveRecoverySecret(
  id: string,
): Promise<string | undefined> {
  const fromFile = (await readRecoveryFile())[id];
  if (fromFile) return fromFile;
  if (await secretToolAvailable()) {
    const result = await runSecretTool([
      "lookup",
      "service",
      "segly",
      "account",
      `recovery:${id}`,
    ]);
    if (result.ok && result.stdout.trim()) return result.stdout.trim();
  }
  return undefined;
}

export async function clearRecoverySecret(id: string): Promise<void> {
  if (await secretToolAvailable()) {
    await runSecretTool([
      "clear",
      "service",
      "segly",
      "account",
      `recovery:${id}`,
    ]);
  }
  const recovery = await readRecoveryFile();
  if (recovery[id] !== undefined) {
    delete recovery[id];
    await writeSecretMap(resolveConfigPaths().recovery, recovery);
  }
}

async function readWebhookFile(): Promise<Record<string, string>> {
  return (
    (await readSecretFile<Record<string, string>>(
      resolveConfigPaths().webhooks,
    )) ??
    {}
  );
}

export async function storeWebhookSecret(
  id: string,
  secret: string,
): Promise<CredentialStore> {
  if (await secretToolAvailable()) {
    const result = await runSecretTool(
      [
        "store",
        "--label=Segly webhook signing secret",
        "service",
        "segly",
        "account",
        `webhook:${id}`,
      ],
      secret,
    );
    if (result.ok) {
      const webhooks = await readWebhookFile();
      if (webhooks[id] !== undefined) {
        delete webhooks[id];
        await writeSecretMap(resolveConfigPaths().webhooks, webhooks);
      }
      return "secret-service";
    }
  }
  const webhooks = await readWebhookFile();
  webhooks[id] = secret;
  return await writeSecretMap(resolveConfigPaths().webhooks, webhooks);
}

export async function resolveWebhookSecret(
  id: string,
): Promise<string | undefined> {
  const fromFile = (await readWebhookFile())[id];
  if (fromFile) return fromFile;
  if (await secretToolAvailable()) {
    const result = await runSecretTool([
      "lookup",
      "service",
      "segly",
      "account",
      `webhook:${id}`,
    ]);
    if (result.ok && result.stdout.trim()) return result.stdout.trim();
  }
  return undefined;
}

export async function clearWebhookSecret(id: string): Promise<void> {
  if (await secretToolAvailable()) {
    await runSecretTool([
      "clear",
      "service",
      "segly",
      "account",
      `webhook:${id}`,
    ]);
  }
  const webhooks = await readWebhookFile();
  if (webhooks[id] !== undefined) {
    delete webhooks[id];
    await writeSecretMap(resolveConfigPaths().webhooks, webhooks);
  }
}

export async function clearApiKey(): Promise<void> {
  const metadata = await readMetadata();
  if (
    metadata.credential_store === "secret-tool" ||
    (await secretToolAvailable())
  ) {
    await runSecretTool(["clear", "service", "segly", "account", "default"]);
  }
  await unlink(resolveConfigPaths().credentials).catch(() => undefined);
  const { credential_store: _removed, ...withoutCredentialStore } = metadata;
  await writeMetadata(withoutCredentialStore);
}

export async function credentialsFileIsPrivate(): Promise<boolean> {
  const path = resolveConfigPaths().credentials;
  try {
    await access(path, fsConstants.F_OK);
    if (process.platform === "win32") {
      return isWindowsDpapiEnvelope(await readJson<unknown>(path));
    }
    return ((await stat(path)).mode & 0o077) === 0;
  } catch {
    return true;
  }
}
