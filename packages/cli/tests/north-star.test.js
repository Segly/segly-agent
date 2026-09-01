import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiClient } from "../dist/api.js";
import { OperationJournal } from "../dist/journal.js";
import { SeglyService } from "../dist/service.js";

const TEST_API_KEY = `sgly_test_${"n".repeat(32)}`;

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

async function readBytes(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const bytes = await readBytes(request);
  return bytes.length === 0 ? {} : JSON.parse(bytes.toString("utf8"));
}

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

test("local north-star covers discovery, one idempotent spend, verified delivery, and explicit purchase", async (t) => {
  const privateTemporaryRoot = process.platform === "linux" ? "/tmp" : tmpdir();
  const directory = await mkdtemp(
    join(privateTemporaryRoot, "segly-north-star-"),
  );
  t.after(async () => rm(directory, { recursive: true }));
  const imagePath = join(directory, "character.png");
  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  await writeFile(imagePath, imageBytes);

  const artifactBytes = Buffer.from("verified local Segly artifact");
  const artifactSha256 = createHash("sha256")
    .update(artifactBytes)
    .digest("hex");
  const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");
  const operationJournal = new OperationJournal(
    join(directory, "operations.json"),
  );

  let baseUrl = "";
  let uploadedBytes = Buffer.alloc(0);
  let balance = 5;
  let segmentationAttempts = 0;
  let segmentationDebits = 0;
  let segmentationPolls = 0;
  let artifactPreparations = 0;
  let artifactReads = 0;
  let hostedPurchases = 0;
  let uploadContract;
  const segmentationKeys = [];
  const segmentationBodies = [];
  const purchaseKeys = [];
  const purchaseBodies = [];
  const protectedAuthorizations = [];
  const publicAuthorizations = [];
  const signedAuthorizations = [];
  const signedUploadTokens = [];
  const ledger = [];

  const publicPaths = new Set([
    "/agents.md",
    "/v1/capabilities",
    "/v1/payment-capabilities",
    "/v1/credit-packs",
  ]);

  const { server, url } = await listen(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://segly.local");
    const path = requestUrl.pathname;
    if (path.startsWith("/v1/") && !publicPaths.has(path)) {
      protectedAuthorizations.push(request.headers.authorization);
    } else if (publicPaths.has(path)) {
      publicAuthorizations.push(request.headers.authorization);
    }

    if (request.method === "GET" && path === "/agents.md") {
      response.writeHead(200, { "content-type": "text/markdown" });
      response.end(
        [
          "# Segly for agents",
          "`npx @segly/cli`",
          "Prediction costs 0 credits.",
          "Segmentation requires explicit layers and `--max-credits 5`.",
        ].join("\n"),
      );
      return;
    }

    if (request.method === "GET" && path === "/v1/capabilities") {
      json(response, 200, {
        api_version: "v1",
        availability: "available",
        formats: {
          input: ["image/png", "image/jpeg", "image/webp"],
          output: [
            "mask",
            "preview",
            "zip",
            "psd",
            "live2d_psd",
            "rig_metadata",
          ],
        },
        limits: {
          upload_bytes: 10 * 1024 * 1024,
          image_pixels: 25_000_000,
          layers_min: 1,
          layers_max: 32,
          layer_name_characters: 64,
          layer_name_format: "lowercase_ascii_snake_case",
        },
        workflows: [{ id: "character-simple", predictable: true }],
        pricing: { prediction_credits: 0, segmentation_credits: 5 },
        retention: {
          jobs_days: 90,
          package_cache_hours: 24,
          signed_download_minutes: 15,
        },
        auth: { methods: ["supabase_jwt", "api_key", "oauth_2_1"] },
        features: { webhooks: true, remote_mcp: true, machine_accounts: false },
        expected_latency_seconds: { minimum: 60, maximum: 180 },
        links: {
          openapi: "/v1/openapi.json",
          oauth_resource: "/.well-known/oauth-protected-resource/v1",
          mcp: "/mcp",
        },
      });
      return;
    }

    if (request.method === "GET" && path === "/v1/payment-capabilities") {
      json(response, 200, {
        hosted_checkout: { available: true, requires_user_action: true },
        machine_payments: {
          available: false,
          provider: null,
          rails: [],
          reason: "implementation_not_enabled",
        },
        packs_url: "/v1/credit-packs",
      });
      return;
    }

    if (request.method === "POST" && path === "/v1/uploads") {
      const body = await readJson(request);
      uploadContract = body;
      json(response, 201, {
        id: "upload_north_star",
        status: "pending",
        received_contract: body,
        upload: {
          method: "PUT",
          url: `${baseUrl}/signed-upload/upload_north_star`,
          headers: { "X-Segly-Upload-Token": "opaque-test-upload-token" },
        },
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      return;
    }

    if (
      request.method === "PUT" &&
      path === "/signed-upload/upload_north_star"
    ) {
      signedAuthorizations.push(request.headers.authorization);
      signedUploadTokens.push(request.headers["x-segly-upload-token"]);
      uploadedBytes = await readBytes(request);
      response.writeHead(204);
      response.end();
      return;
    }

    if (
      request.method === "POST" &&
      path === "/v1/uploads/upload_north_star/complete"
    ) {
      await readJson(request);
      json(response, 200, {
        id: "upload_north_star",
        status: "ready",
        content_type: "image/png",
        size_bytes: uploadedBytes.length,
        sha256: createHash("sha256").update(uploadedBytes).digest("hex"),
        width: 1,
        height: 1,
      });
      return;
    }

    if (request.method === "POST" && path === "/v1/layer-predictions") {
      const body = await readJson(request);
      json(response, 200, {
        upload_id: body.upload_id,
        workflow: body.workflow,
        layers: ["head", "body"],
        source: "model",
        credits: 0,
      });
      return;
    }

    if (request.method === "POST" && path === "/v1/segmentations") {
      const body = await readJson(request);
      const idempotencyKey = request.headers["idempotency-key"];
      segmentationAttempts += 1;
      segmentationKeys.push(idempotencyKey);
      segmentationBodies.push(body);

      if (segmentationDebits === 0) {
        segmentationDebits += 1;
        balance -= 5;
        ledger.push({
          id: "credit_txn_north_star",
          type: "segmentation",
          amount: -5,
          credit_state: "spent",
          segmentation_id: "seg_north_star",
          refund_on_failure: true,
        });

        // The durable job and debit exist, but the client never receives the
        // response. Its bounded retry must replay this exact operation.
        response.destroy();
        return;
      }

      json(
        response,
        202,
        {
          id: "seg_north_star",
          status: "queued",
          credit_state: "reserved",
          credits: 5,
        },
        {
          location: "/v1/segmentations/seg_north_star",
          "retry-after": "0",
        },
      );
      return;
    }

    if (
      request.method === "GET" &&
      path === "/v1/segmentations/seg_north_star"
    ) {
      segmentationPolls += 1;
      const succeeded = segmentationPolls >= 2;
      json(
        response,
        200,
        {
          id: "seg_north_star",
          status: succeeded ? "succeeded" : "processing",
          credit_state: "spent",
          credits: 5,
        },
        succeeded ? {} : { "retry-after": "0" },
      );
      return;
    }

    if (
      request.method === "POST" &&
      path === "/v1/segmentations/seg_north_star/artifacts/zip/prepare"
    ) {
      artifactPreparations += 1;
      await readJson(request);
      json(response, 202, { kind: "zip", status: "preparing" });
      return;
    }

    if (
      request.method === "GET" &&
      path === "/v1/segmentations/seg_north_star/artifacts/zip"
    ) {
      artifactReads += 1;
      json(response, 200, {
        kind: "zip",
        status: "ready",
        content_type: "application/zip",
        size_bytes: artifactBytes.length,
        sha256: artifactSha256,
        url: `${baseUrl}/signed-artifact/seg_north_star.zip`,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      return;
    }

    if (
      request.method === "GET" &&
      path === "/signed-artifact/seg_north_star.zip"
    ) {
      signedAuthorizations.push(request.headers.authorization);
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(artifactBytes.length),
      });
      response.end(artifactBytes);
      return;
    }

    if (request.method === "GET" && path === "/v1/credits/balance") {
      json(response, 200, { balance, currency: "credits" });
      return;
    }

    if (request.method === "GET" && path === "/v1/credits/transactions") {
      json(response, 200, { items: ledger, next_cursor: null });
      return;
    }

    if (request.method === "GET" && path === "/v1/credit-packs") {
      json(response, 200, {
        items: [
          {
            id: "pack_20",
            credits: 20,
            price_cents: 1_200,
            currency: "jpy",
          },
        ],
      });
      return;
    }

    if (request.method === "POST" && path === "/v1/credit-purchases/checkout") {
      hostedPurchases += 1;
      const body = await readJson(request);
      purchaseKeys.push(request.headers["idempotency-key"]);
      purchaseBodies.push(body);
      json(response, 201, {
        id: "checkout_north_star",
        status: "requires_user_action",
        pack_id: body.pack_id,
        price_cents: 1_200,
        checkout_url: "https://checkout.example/session/redacted-by-caller",
      });
      return;
    }

    json(response, 404, {
      status: 404,
      code: "not_found",
      retryable: false,
    });
  });
  baseUrl = url;
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  // A clean agent starts from the public discovery document and capability
  // resources before invoking the CLI's shared service contract.
  const agentsDocument = await fetch(`${baseUrl}/agents.md`).then((response) =>
    response.text(),
  );
  assert.match(agentsDocument, /npx @segly\/cli/u);
  assert.match(agentsDocument, /max-credits 5/u);

  const service = new SeglyService(
    new ApiClient({
      baseUrl,
      apiKey: TEST_API_KEY,
      maxRetries: 1,
      timeoutMs: 2_000,
      sleepImplementation: async () => undefined,
    }),
    operationJournal,
  );
  const capabilities = await service.capabilities();
  const paymentCapabilities = await service.paymentCapabilities();
  assert.equal(capabilities.pricing.prediction_credits, 0);
  assert.equal(capabilities.pricing.segmentation_credits, 5);
  assert.equal(capabilities.availability, "available");
  assert.deepEqual(capabilities.workflows, [
    { id: "character-simple", predictable: true },
  ]);
  assert.equal(paymentCapabilities.hosted_checkout.available, true);
  assert.equal(paymentCapabilities.machine_payments.available, false);

  const preview = await service.previewPredictedSegmentation(imagePath, {
    workflow: "character-simple",
    maxCredits: 5,
    operationId: "north_star_segmentation",
  });
  assert.equal(preview.status, "awaiting_layer_review");
  assert.deepEqual(preview.prediction.layers, ["head", "body"]);
  assert.equal(preview.prediction.credits, 0);
  assert.deepEqual(preview.credit_boundary, {
    segmentation_credits: 5,
    submission_started: false,
  });
  assert.equal(preview.resume.operation_id, "north_star_segmentation");
  assert.equal(preview.resume.required_flag, "--accept-predicted-layers");
  assert.equal(segmentationAttempts, 0);
  assert.equal(segmentationDebits, 0);

  const created = await service.createSegmentation(imagePath, {
    workflow: "character-simple",
    predictLayers: true,
    acceptPredictedLayers: true,
    maxCredits: 5,
    operationId: "north_star_segmentation",
  });
  assert.equal(created.segmentation.id, "seg_north_star");
  assert.equal(segmentationAttempts, 2);
  assert.equal(segmentationDebits, 1);
  assert.equal(new Set(segmentationKeys).size, 1);
  assert.deepEqual(segmentationBodies[0], segmentationBodies[1]);
  assert.deepEqual(segmentationBodies[0], {
    upload_id: "upload_north_star",
    workflow: "character-simple",
    layers: ["head", "body"],
    max_credits: 5,
  });
  assert.deepEqual(uploadContract, {
    filename: "character.png",
    content_type: "image/png",
    size_bytes: imageBytes.length,
    sha256: imageSha256,
  });
  assert.deepEqual(uploadedBytes, imageBytes);
  assert.equal(
    imageSha256,
    createHash("sha256").update(uploadedBytes).digest("hex"),
  );
  assert.equal(hostedPurchases, 0, "segmentation must never auto-top-up");

  const finished = await service.waitForSegmentation("seg_north_star", {
    timeoutMs: 1_000,
    pollIntervalMs: 1,
  });
  assert.equal(finished.status, "succeeded");
  assert.equal(segmentationPolls, 2);

  const artifactPath = join(directory, "segmentation.zip");
  const downloaded = await service.downloadArtifact(
    "seg_north_star",
    "zip",
    artifactPath,
    { timeoutMs: 1_000, pollIntervalMs: 1 },
  );
  assert.equal(artifactPreparations, 1);
  assert.equal(artifactReads, 1);
  assert.equal(downloaded.sha256, artifactSha256);
  assert.equal(downloaded.bytes, artifactBytes.length);
  assert.deepEqual(await readFile(artifactPath), artifactBytes);

  const creditBalance = await service.creditBalance();
  const creditHistory = await service.creditHistory();
  assert.equal(creditBalance.balance, 0);
  assert.equal(creditHistory.items.length, 1);
  assert.deepEqual(creditHistory.items[0], {
    id: "credit_txn_north_star",
    type: "segmentation",
    amount: -5,
    credit_state: "spent",
    segmentation_id: "seg_north_star",
    refund_on_failure: true,
  });
  assert.equal(hostedPurchases, 0, "ledger reads must never start payment");

  const purchase = await service.buyCredits({
    packId: "pack_20",
    method: "hosted",
    maxPriceCents: 1_200,
    operationId: "north_star_purchase",
  });
  assert.equal(purchase.status, "requires_user_action");
  assert.equal(purchase.operation_id, "north_star_purchase");
  assert.equal(hostedPurchases, 1);
  assert.equal(typeof purchaseKeys[0], "string");
  assert.deepEqual(purchaseBodies, [
    { pack_id: "pack_20", max_price_cents: 1_200 },
  ]);
  assert.equal(balance, 0, "beginning hosted checkout must not grant credits");

  assert.ok(protectedAuthorizations.length > 0);
  assert.ok(
    protectedAuthorizations.every(
      (authorization) => authorization === `Bearer ${TEST_API_KEY}`,
    ),
  );
  assert.ok(publicAuthorizations.every((authorization) => !authorization));
  assert.deepEqual(signedAuthorizations, [undefined, undefined]);
  assert.deepEqual(signedUploadTokens, ["opaque-test-upload-token"]);
});
