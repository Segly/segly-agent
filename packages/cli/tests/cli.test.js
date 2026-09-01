import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ApiClient } from "../dist/api.js";
import { createCli } from "../dist/cli.js";
import {
  clearApiKey,
  credentialsFileIsPrivate,
  resolveCredential,
  resolveConfigPaths,
  resolveRecoverySecret,
  resolveWebhookSecret,
  storeApiKey,
} from "../dist/config.js";
import { atomicDownload } from "../dist/files.js";
import { OperationJournal, fingerprint } from "../dist/journal.js";
import { parseLayersDocument } from "../dist/layers-file.js";
import { buildMcpServer } from "../dist/mcp.js";
import { assertCreditGuards, SeglyService } from "../dist/service.js";

const temporaryDirectories = [];
const originalEnvironment = {
  config: process.env.SEGLY_CONFIG_DIR,
  key: process.env.SEGLY_API_KEY,
  disableKeychain: process.env.SEGLY_DISABLE_KEYCHAIN,
};

async function temporaryDirectory() {
  const base = process.platform === "linux" ? "/tmp" : tmpdir();
  const directory = await mkdtemp(join(base, "segly-cli-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

after(async () => {
  if (originalEnvironment.config === undefined)
    delete process.env.SEGLY_CONFIG_DIR;
  else process.env.SEGLY_CONFIG_DIR = originalEnvironment.config;
  if (originalEnvironment.key === undefined) delete process.env.SEGLY_API_KEY;
  else process.env.SEGLY_API_KEY = originalEnvironment.key;
  if (originalEnvironment.disableKeychain === undefined)
    delete process.env.SEGLY_DISABLE_KEYCHAIN;
  else process.env.SEGLY_DISABLE_KEYCHAIN = originalEnvironment.disableKeychain;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

test("fallback credentials and journals are private and secrets are never returned", async () => {
  const directory = await temporaryDirectory();
  process.env.SEGLY_CONFIG_DIR = directory;
  process.env.SEGLY_DISABLE_KEYCHAIN = "1";
  delete process.env.SEGLY_API_KEY;
  const secret = `sgly_test_${"a".repeat(32)}`;

  assert.equal(await storeApiKey(secret), "file");
  assert.deepEqual(await resolveCredential(), {
    apiKey: secret,
    source: "file",
  });
  const credentialPath = resolveConfigPaths().credentials;
  const credentialMode = (await stat(credentialPath)).mode;
  assert.equal(
    await credentialsFileIsPrivate(),
    true,
    JSON.stringify({
      credentialPath,
      credentialMode: credentialMode.toString(8),
    }),
  );
  assert.equal(credentialMode & 0o077, 0);

  const journal = new OperationJournal(join(directory, "operations.json"));
  const first = await journal.open(
    "op_resume",
    fingerprint({ image: "digest", workflow: "background" }),
  );
  const repeated = await journal.open(
    "op_resume",
    fingerprint({ image: "digest", workflow: "background" }),
  );
  assert.equal(first.idempotency_key, repeated.idempotency_key);
  await assert.rejects(
    journal.open("op_resume", fingerprint({ image: "different" })),
    (error) => error.code === "operation_conflict",
  );
  assert.equal(
    (await stat(join(directory, "operations.json"))).mode & 0o077,
    0,
  );
  assert.ok(
    !(await readFile(join(directory, "operations.json"), "utf8")).includes(
      secret,
    ),
  );

  await clearApiKey();
  await assert.rejects(
    resolveCredential(),
    (error) => error.code === "authentication_required",
  );
});

test("concurrent journal operations retain every idempotency record", async () => {
  const directory = await temporaryDirectory();
  const journalPath = join(directory, "operations.json");
  const journals = Array.from(
    { length: 4 },
    () => new OperationJournal(journalPath),
  );
  const operationIds = Array.from({ length: 24 }, (_, index) => `op_${index}`);
  const records = await Promise.all(
    operationIds.map((operationId, index) =>
      journals[index % journals.length].open(
        operationId,
        fingerprint({ index }),
      ),
    ),
  );
  assert.equal(
    new Set(records.map((record) => record.idempotency_key)).size,
    24,
  );

  await Promise.all(
    operationIds.map((operationId, index) =>
      journals[(index + 1) % journals.length].update(operationId, {
        resource_id: `resource_${index}`,
      }),
    ),
  );
  const stored = JSON.parse(await readFile(journalPath, "utf8"));
  assert.deepEqual(Object.keys(stored.operations).sort(), operationIds.sort());
  for (let index = 0; index < operationIds.length; index += 1) {
    assert.equal(
      stored.operations[`op_${index}`].resource_id,
      `resource_${index}`,
    );
  }
});

test("layers files accept arrays and exact prediction responses but reject unrelated JSON", () => {
  assert.deepEqual(parseLayersDocument('["head", "body"]'), ["head", "body"]);
  assert.deepEqual(
    parseLayersDocument(
      JSON.stringify({
        workflow: "character-simple",
        layers: ["head", "body"],
        source: "model",
        credits: 0,
      }),
    ),
    ["head", "body"],
  );
  assert.deepEqual(parseLayersDocument("head\nbody\n"), ["head", "body"]);
  assert.throws(
    () =>
      parseLayersDocument(
        JSON.stringify({ items: ["head"], secret: "ignored" }),
      ),
    (error) => error.code === "invalid_layers",
  );
  assert.throws(
    () =>
      parseLayersDocument(
        JSON.stringify({ layers: ["head"], unrelated: true }),
      ),
    (error) => error.code === "invalid_layers",
  );
});

test("paid credit guards require per-job and aggregate approval", () => {
  assert.doesNotThrow(() => assertCreditGuards(1, 5, undefined));
  assert.doesNotThrow(() => assertCreditGuards(2, 5, 10));
  assert.throws(() => assertCreditGuards(1, undefined, undefined));
  assert.throws(() => assertCreditGuards(2, 5, undefined));
  assert.throws(() => assertCreditGuards(2, 5, 5));
});

test("paid submission retries with one journaled idempotency key and upload", async (t) => {
  const directory = await temporaryDirectory();
  const imagePath = join(directory, "input.png");
  await writeFile(
    imagePath,
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
  );
  const idempotencyKeys = [];
  let segmentationAttempts = 0;
  let uploads = 0;
  let baseUrl = "";
  const { server, url } = await listen(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/uploads") {
      uploads += 1;
      return json(response, 201, {
        id: "upload_1",
        status: "pending",
        upload: { method: "PUT", url: `${baseUrl}/signed-upload`, headers: {} },
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    if (request.method === "PUT" && request.url === "/signed-upload") {
      request.resume();
      response.writeHead(200);
      return response.end();
    }
    if (
      request.method === "POST" &&
      request.url === "/v1/uploads/upload_1/complete"
    ) {
      return json(response, 200, { id: "upload_1", status: "ready" });
    }
    if (request.method === "POST" && request.url === "/v1/segmentations") {
      segmentationAttempts += 1;
      idempotencyKeys.push(request.headers["idempotency-key"]);
      request.resume();
      if (segmentationAttempts === 1) {
        return json(
          response,
          503,
          {
            status: 503,
            title: "retry",
            code: "temporarily_unavailable",
            retryable: true,
          },
          { "retry-after": "0" },
        );
      }
      return json(response, 202, { id: "job_1", status: "queued" });
    }
    if (request.method === "GET" && request.url === "/v1/segmentations/job_1") {
      return json(response, 200, { id: "job_1", status: "queued" });
    }
    json(response, 404, { status: 404, code: "not_found" });
  });
  baseUrl = url;
  t.after(() => server.close());

  const service = new SeglyService(
    new ApiClient({
      baseUrl,
      apiKey: `sgly_test_${"b".repeat(32)}`,
      maxRetries: 1,
      timeoutMs: 2_000,
    }),
    new OperationJournal(join(directory, "operations.json")),
  );
  const created = await service.createSegmentation(imagePath, {
    workflow: "background",
    layers: ["foreground", "background"],
    maxCredits: 5,
    operationId: "op_stable",
  });
  assert.equal(created.segmentation.id, "job_1");
  assert.equal(segmentationAttempts, 2);
  assert.equal(new Set(idempotencyKeys).size, 1);
  assert.equal(uploads, 1);

  const resumed = await service.createSegmentation(imagePath, {
    workflow: "background",
    layers: ["foreground", "background"],
    maxCredits: 5,
    operationId: "op_stable",
  });
  assert.equal(resumed.segmentation.id, "job_1");
  assert.equal(segmentationAttempts, 2);
  assert.equal(uploads, 1);
});

test("API retries obey retryable=false and exact Retry-After guidance", async () => {
  let rejectedAttempts = 0;
  const rejectedDelays = [];
  const rejectedClient = new ApiClient({
    baseUrl: "https://api.example",
    apiKey: `sgly_test_${"r".repeat(32)}`,
    maxRetries: 2,
    fetchImplementation: async () => {
      rejectedAttempts += 1;
      return new Response(
        JSON.stringify({
          status: 503,
          code: "launch_gate_closed",
          retryable: false,
        }),
        {
          status: 503,
          headers: {
            "content-type": "application/problem+json",
            "retry-after": "60",
          },
        },
      );
    },
    sleepImplementation: async (delay) => {
      rejectedDelays.push(delay);
    },
  });
  await assert.rejects(
    rejectedClient.post("/v1/segmentations", {
      body: {},
      retryable: true,
    }),
    (error) => error.code === "launch_gate_closed",
  );
  assert.equal(rejectedAttempts, 1);
  assert.deepEqual(rejectedDelays, []);

  let retryAttempts = 0;
  const retryDelays = [];
  const retryingClient = new ApiClient({
    baseUrl: "https://api.example",
    apiKey: `sgly_test_${"s".repeat(32)}`,
    maxRetries: 1,
    fetchImplementation: async () => {
      retryAttempts += 1;
      if (retryAttempts === 1) {
        return new Response(
          JSON.stringify({
            status: 429,
            code: "rate_limit_exceeded",
            retryable: true,
          }),
          { status: 429, headers: { "retry-after": "61" } },
        );
      }
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    },
    sleepImplementation: async (delay) => {
      retryDelays.push(delay);
    },
  });
  assert.deepEqual(await retryingClient.get("/v1/capabilities"), {
    status: "ok",
  });
  assert.equal(retryAttempts, 2);
  assert.deepEqual(retryDelays, [61_000]);
});

test("segmentation polling uses the successful response Retry-After header", async (t) => {
  let polls = 0;
  const { server, url } = await listen((request, response) => {
    if (request.method === "GET" && request.url === "/v1/segmentations/job_1") {
      polls += 1;
      return json(
        response,
        200,
        { id: "job_1", status: polls === 1 ? "queued" : "succeeded" },
        polls === 1 ? { "retry-after": "0.001" } : {},
      );
    }
    json(response, 404, { status: 404, code: "not_found" });
  });
  t.after(() => server.close());
  const service = new SeglyService(
    new ApiClient({
      baseUrl: url,
      apiKey: `sgly_test_${"t".repeat(32)}`,
      maxRetries: 0,
    }),
  );
  const started = Date.now();
  const result = await service.waitForSegmentation("job_1", {
    timeoutMs: 1_000,
    pollIntervalMs: 500,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(polls, 2);
  assert.ok(Date.now() - started < 400);
});

test("atomic downloads verify SHA-256 and never publish mismatched bytes", async () => {
  const directory = await temporaryDirectory();
  const bytes = Buffer.from("verified artifact");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const output = join(directory, "artifact.zip");
  const downloaded = await atomicDownload(new Response(bytes), output, digest);
  assert.equal(downloaded.sha256, digest);
  assert.deepEqual(await readFile(output), bytes);

  const mismatchOutput = join(directory, "mismatch.zip");
  await assert.rejects(
    atomicDownload(new Response(bytes), mismatchOutput, "0".repeat(64)),
    (error) => error.code === "checksum_mismatch",
  );
  await assert.rejects(
    stat(mismatchOutput),
    (error) => error.code === "ENOENT",
  );

  const sizeMismatchOutput = join(directory, "size-mismatch.zip");
  await assert.rejects(
    atomicDownload(
      new Response(bytes),
      sizeMismatchOutput,
      digest,
      false,
      bytes.length + 1,
    ),
    (error) => error.code === "size_mismatch",
  );
  await assert.rejects(
    stat(sizeMismatchOutput),
    (error) => error.code === "ENOENT",
  );
});

test("artifact downloads refuse responses without verification metadata", async () => {
  const directory = await temporaryDirectory();
  const service = new SeglyService(
    new ApiClient({
      baseUrl: "https://api.invalid",
      apiKey: `sgly_test_${"v".repeat(32)}`,
      fetchImplementation: async () => {
        throw new Error("signed download must not start");
      },
    }),
    new OperationJournal(join(directory, "operations.json")),
  );
  service.prepareArtifact = async () => ({
    kind: "zip",
    status: "ready",
    url: "https://storage.invalid/artifact?signature=secret",
    size_bytes: 10,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  await assert.rejects(
    service.downloadArtifact("job_1", "zip", join(directory, "artifact.zip")),
    (error) =>
      error.code === "invalid_api_response" &&
      error.message.includes("SHA-256"),
  );
});

test("MCP paid tools require stable operation IDs and signed URLs stay out of output", async (t) => {
  const fakeService = {
    prepareArtifact: async () => ({
      kind: "zip",
      status: "ready",
      url: "https://storage.example/artifact?signature=secret",
      sha256: "a".repeat(64),
    }),
    buyCredits: async () => ({
      operation_id: "purchase-operation-123",
      session_id: "cs_live_private_session",
      checkout_url:
        "https://checkout.stripe.example/c/pay/cs_live_private_session?token=secret",
      pack_id: "starter_25",
    }),
  };
  const server = buildMcpServer(fakeService);
  const client = new Client({ name: "segly-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const tools = await client.listTools();
  for (const name of ["create_segmentation", "begin_credit_purchase"]) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} should be registered`);
    assert.ok(tool.inputSchema.required.includes("operation_id"));
    assert.equal(tool.annotations.idempotentHint, true);
    if (name === "create_segmentation") {
      assert.ok(tool.inputSchema.required.includes("layers"));
      assert.equal(tool.inputSchema.properties.predict_layers, undefined);
    }
  }
  const prepared = await client.callTool({
    name: "prepare_artifact",
    arguments: { segmentation_id: "job_1", kind: "zip", retry: false },
  });
  const serialized = JSON.stringify(prepared);
  assert.ok(!serialized.includes("signature=secret"));
  assert.ok(!serialized.includes("storage.example"));

  const purchase = await client.callTool({
    name: "begin_credit_purchase",
    arguments: {
      pack_id: "starter_25",
      method: "hosted",
      max_price_cents: 500,
      confirmed: true,
      operation_id: "purchase-operation-123",
    },
  });
  const serializedPurchase = JSON.stringify({
    content: purchase.content,
    structuredContent: purchase.structuredContent,
  });
  assert.ok(!serializedPurchase.includes("checkout.stripe.example"));
  assert.ok(!serializedPurchase.includes("cs_live_private_session"));
  assert.equal(
    purchase._meta["io.segly/checkout"].url,
    "https://checkout.stripe.example/c/pay/cs_live_private_session?token=secret",
  );
});

test("MCP v2 server negotiates both current and legacy clients", async () => {
  const cliPath = join(process.cwd(), "dist", "bin.js");
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== undefined),
  );
  for (const versionNegotiation of [
    { mode: "legacy" },
    { mode: { pin: "2026-07-28" } },
  ]) {
    const client = new Client(
      { name: "segly-negotiation-test", version: "0.1.0" },
      { versionNegotiation },
    );
    const clientTransport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, "mcp"],
      env: {
        ...inheritedEnvironment,
        SEGLY_API_KEY: `sgly_live_${"a".repeat(48)}`,
        SEGLY_DISABLE_KEYCHAIN: "true",
      },
      stderr: "pipe",
    });
    try {
      await client.connect(clientTransport);
      const tools = await client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === "get_capabilities"));
    } finally {
      await client.close();
    }
  }
});

test("CLI artifact prepare strips signed URLs while keeping status metadata", async (t) => {
  process.env.SEGLY_API_KEY = `sgly_test_${"c".repeat(32)}`;
  const { server, url } = await listen((request, response) => {
    if (
      request.method === "POST" &&
      request.url === "/v1/segmentations/job_1/artifacts/zip/prepare"
    ) {
      return json(response, 200, {
        kind: "zip",
        status: "ready",
        url: "https://storage.example/artifact?signature=secret",
        sha256: "f".repeat(64),
      });
    }
    json(response, 404, { status: 404, code: "not_found" });
  });
  t.after(() => server.close());
  const results = [];
  const output = {
    result: (value) => results.push(value),
    progress: () => {},
    failure: (error) => {
      throw error;
    },
  };
  await createCli({ output }).parseAsync([
    "node",
    "segly",
    "--api-url",
    url,
    "artifact",
    "prepare",
    "job_1",
    "zip",
    "--json",
  ]);
  assert.deepEqual(results, [
    { kind: "zip", status: "ready", sha256: "f".repeat(64) },
  ]);
});

test("webhook list accepts arrays and create stores its one-time secret without outputting it", async (t) => {
  const directory = await temporaryDirectory();
  process.env.SEGLY_CONFIG_DIR = directory;
  process.env.SEGLY_DISABLE_KEYCHAIN = "1";
  process.env.SEGLY_API_KEY = `sgly_test_${"w".repeat(32)}`;
  const webhookSecret = "whsec_private_value";
  const { server, url } = await listen(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/webhooks") {
      return json(response, 200, [
        { id: "webhook_1", url: "https://hooks.example/segly" },
      ]);
    }
    if (request.method === "POST" && request.url === "/v1/webhooks") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
        url: "https://hooks.example/segly",
        events: ["segmentation.succeeded"],
      });
      return json(response, 201, {
        webhook: {
          id: "webhook_1",
          url: "https://hooks.example/segly",
          events: ["segmentation.succeeded"],
        },
        secret: webhookSecret,
      });
    }
    json(response, 404, { status: 404, code: "not_found" });
  });
  t.after(() => server.close());

  const results = [];
  const output = {
    result: (value) => results.push(value),
    progress: () => {},
    failure: (error) => {
      throw error;
    },
  };
  await createCli({ output }).parseAsync([
    "node",
    "segly",
    "--api-url",
    url,
    "webhooks",
    "list",
  ]);
  assert.deepEqual(results.pop(), {
    items: [{ id: "webhook_1", url: "https://hooks.example/segly" }],
  });
  await createCli({ output }).parseAsync([
    "node",
    "segly",
    "--api-url",
    url,
    "webhooks",
    "create",
    "--url",
    "https://hooks.example/segly",
    "--event",
    "segmentation.succeeded",
  ]);
  const created = results.pop();
  assert.deepEqual(created, {
    webhook: {
      id: "webhook_1",
      url: "https://hooks.example/segly",
      events: ["segmentation.succeeded"],
    },
    secret_stored: true,
    secret_store: "file",
  });
  assert.ok(!JSON.stringify(created).includes(webhookSecret));
  assert.equal(await resolveWebhookSecret("webhook_1"), webhookSecret);
  assert.equal((await stat(resolveConfigPaths().webhooks)).mode & 0o077, 0);
});

test("OAuth login reports unavailable from discovery without inventing a login route", async (t) => {
  const { server, url } = await listen((_request, response) => {
    json(response, 404, { status: 404, code: "not_found" });
  });
  t.after(() => server.close());
  const { loginWithOAuth } = await import("../dist/oauth.js");
  assert.deepEqual(await loginWithOAuth({ apiUrl: url, open: false }), {
    available: false,
    reason: "oauth_not_enabled",
  });
});

test("OAuth login uses discovery, DCR, PKCE, loopback callback, and private token storage", async (t) => {
  const directory = await temporaryDirectory();
  process.env.SEGLY_CONFIG_DIR = directory;
  process.env.SEGLY_DISABLE_KEYCHAIN = "1";
  delete process.env.SEGLY_API_KEY;
  delete process.env.SEGLY_OAUTH_CLIENT_ID;
  let baseUrl = "";
  let redirectUri = "";
  let codeChallenge = "";
  const { server, url } = await listen(async (request, response) => {
    if (request.url === "/.well-known/oauth-protected-resource/v1") {
      return json(response, 200, {
        authorization_servers: [`${baseUrl}/auth/v1`],
      });
    }
    if (request.url === "/auth/v1/.well-known/oauth-authorization-server") {
      return json(response, 200, {
        issuer: `${baseUrl}/auth/v1`,
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
        registration_endpoint: `${baseUrl}/oauth/register`,
        scopes_supported: ["openid", "profile", "email", "offline_access"],
      });
    }
    if (request.method === "POST" && request.url === "/oauth/register") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      redirectUri = body.redirect_uris[0];
      assert.equal(body.token_endpoint_auth_method, "none");
      return json(response, 201, { client_id: "client_1" });
    }
    if (
      request.method === "GET" &&
      request.url.startsWith("/oauth/authorize?")
    ) {
      const authorization = new URL(request.url, baseUrl);
      assert.equal(
        authorization.searchParams.get("code_challenge_method"),
        "S256",
      );
      assert.equal(authorization.searchParams.get("client_id"), "client_1");
      codeChallenge = authorization.searchParams.get("code_challenge");
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "code_1");
      callback.searchParams.set(
        "state",
        authorization.searchParams.get("state"),
      );
      response.writeHead(302, { location: callback.toString() });
      return response.end();
    }
    if (request.method === "POST" && request.url === "/oauth/token") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code"), "code_1");
      assert.equal(form.get("client_id"), "client_1");
      const verifier = form.get("code_verifier");
      assert.equal(
        createHash("sha256").update(verifier).digest("base64url"),
        codeChallenge,
      );
      return json(response, 200, {
        access_token: "oauth_access_secret",
        refresh_token: "oauth_refresh_secret",
        expires_in: 3600,
      });
    }
    json(response, 404, { status: 404, code: "not_found" });
  });
  baseUrl = url;
  t.after(() => server.close());
  const { loginWithOAuth } = await import("../dist/oauth.js");
  let browserVisit;
  const result = await loginWithOAuth({
    apiUrl: baseUrl,
    open: false,
    progress: (message) => {
      const marker = "open this authorization URL: ";
      if (message.startsWith(marker)) {
        browserVisit = fetch(message.slice(marker.length));
      }
    },
  });
  await browserVisit;
  assert.equal(result.available, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.credential_store, "file");
  assert.ok(!JSON.stringify(result).includes("oauth_access_secret"));
  assert.equal((await resolveCredential()).apiKey, "oauth_access_secret");
  assert.equal((await stat(resolveConfigPaths().credentials)).mode & 0o077, 0);
});

test("machine bootstrap stores generated recovery material separately and omits secrets", async (t) => {
  const directory = await temporaryDirectory();
  process.env.SEGLY_CONFIG_DIR = directory;
  process.env.SEGLY_DISABLE_KEYCHAIN = "1";
  delete process.env.SEGLY_API_KEY;
  const rootKey = `sgly_test_${"d".repeat(32)}`;
  let bootstrapBody;
  let bootstrapAuthorization;
  const { server, url } = await listen(async (request, response) => {
    if (
      request.method === "POST" &&
      request.url === "/v1/machine-accounts/bootstrap"
    ) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      bootstrapBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      bootstrapAuthorization = request.headers.authorization;
      assert.equal(typeof request.headers["idempotency-key"], "string");
      return json(response, 201, {
        id: "machine_1",
        status: "active",
        secret: rootKey,
      });
    }
    json(response, 404, { status: 404, code: "not_found" });
  });
  t.after(() => server.close());
  const service = new SeglyService(
    new ApiClient({ baseUrl: url, maxRetries: 0 }),
    new OperationJournal(join(directory, "operations.json")),
  );
  const result = await service.createMachineAccount({
    packId: "pack_25",
    termsHash: "e".repeat(64),
    operationId: "op_machine",
  });
  assert.equal(bootstrapAuthorization, undefined);
  assert.deepEqual(bootstrapBody, {
    pack_id: "pack_25",
    recovery_secret_hash: bootstrapBody.recovery_secret_hash,
    terms_hash: "e".repeat(64),
  });
  assert.match(bootstrapBody.recovery_secret_hash, /^[a-f0-9]{64}$/u);
  const recovery = await resolveRecoverySecret("machine_1");
  assert.equal(
    createHash("sha256").update(recovery).digest("hex"),
    bootstrapBody.recovery_secret_hash,
  );
  assert.equal((await resolveCredential()).apiKey, rootKey);
  assert.ok(!JSON.stringify(result).includes(rootKey));
  assert.ok(!JSON.stringify(result).includes(recovery));
  assert.equal(result.recovery_secret_stored, true);
});
