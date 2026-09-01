import { createHash, randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ApiClient } from "./api.js";
import {
  clearRecoverySecret,
  clearWebhookSecret,
  resolveRecoverySecret,
  storeApiKey,
  storeRecoverySecret,
  storeWebhookSecret,
} from "./config.js";
import { CliError } from "./errors.js";
import {
  artifactFilename,
  atomicDownload,
  prepareImage,
  type DownloadResult,
} from "./files.js";
import { fingerprint, newOperationId, OperationJournal } from "./journal.js";
import type {
  ArtifactResource,
  JsonObject,
  JsonValue,
  LayerPrediction,
  PageResource,
  PreparedImage,
  SegmentationResource,
  UploadResource,
} from "./types.js";

export const SEGMENTATION_CREDIT_COST = 5;
export const WORKFLOWS = [
  "character-simple",
  "character-complex",
  "general-simple",
  "general-complex",
  "background",
  "spine-psd",
  "live2d-psd",
] as const;

export type Workflow = (typeof WORKFLOWS)[number];

function asObject(value: JsonValue, context: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(`Segly API returned an invalid ${context} response`, {
      code: "invalid_api_response",
    });
  }
  return value;
}

function requiredString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new CliError(`Segly API response is missing ${name}`, {
      code: "invalid_api_response",
    });
  }
  return value;
}

function returnedApiKey(response: JsonObject): string | undefined {
  if (typeof response.secret === "string") return response.secret;
  if (
    response.api_key &&
    typeof response.api_key === "object" &&
    !Array.isArray(response.api_key) &&
    typeof response.api_key.secret === "string"
  ) {
    return response.api_key.secret;
  }
  return undefined;
}

function withoutCredentialSecrets(response: JsonObject): JsonObject {
  const safe = { ...response };
  delete safe.secret;
  delete safe.recovery_secret;
  if (
    safe.api_key &&
    typeof safe.api_key === "object" &&
    !Array.isArray(safe.api_key)
  ) {
    const { secret: _secret, ...metadata } = safe.api_key;
    safe.api_key = metadata;
  }
  return safe;
}

function stringRecord(value: JsonValue | undefined): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function validateWorkflow(workflow: string): Workflow {
  if (!(WORKFLOWS as readonly string[]).includes(workflow)) {
    throw new CliError(`Workflow must be one of: ${WORKFLOWS.join(", ")}`, {
      code: "invalid_workflow",
    });
  }
  return workflow as Workflow;
}

export function validateLayers(layers: string[]): string[] {
  const normalized = layers.map((layer) => layer.trim()).filter(Boolean);
  if (normalized.length < 1 || normalized.length > 32) {
    throw new CliError("Segmentation requires between 1 and 32 layers", {
      code: "invalid_layers",
    });
  }
  if (normalized.some((layer) => [...layer].length > 64)) {
    throw new CliError("Each layer name must contain at most 64 characters", {
      code: "invalid_layers",
    });
  }
  const unique = new Set(
    normalized.map((layer) => layer.toLocaleLowerCase("en-US")),
  );
  if (unique.size !== normalized.length) {
    throw new CliError("Layer names must be unique", {
      code: "invalid_layers",
    });
  }
  return normalized;
}

export function assertCreditGuards(
  imageCount: number,
  maxCredits: number | undefined,
  maxTotalCredits: number | undefined,
): void {
  if (maxCredits !== SEGMENTATION_CREDIT_COST) {
    throw new CliError(
      `Paid segmentation requires --max-credits ${SEGMENTATION_CREDIT_COST}`,
      {
        code: "credit_approval_required",
        exitCode: 4,
        details: { required_max_credits: SEGMENTATION_CREDIT_COST },
      },
    );
  }
  const total = imageCount * SEGMENTATION_CREDIT_COST;
  if (imageCount > 1 && maxTotalCredits === undefined) {
    throw new CliError("Multiple images require --max-total-credits", {
      code: "total_credit_approval_required",
      exitCode: 4,
      details: { required_minimum: total },
    });
  }
  if (maxTotalCredits !== undefined && maxTotalCredits < total) {
    throw new CliError("The requested jobs exceed --max-total-credits", {
      code: "total_credit_limit_exceeded",
      exitCode: 4,
      details: { required_credits: total, max_total_credits: maxTotalCredits },
    });
  }
}

export interface CreateSegmentationOptions {
  workflow: Workflow;
  layers?: string[];
  predictLayers?: boolean;
  acceptPredictedLayers?: boolean;
  maxCredits: number;
  operationId?: string;
  progress?: (message: string) => void;
}

export interface CreateSegmentationResult extends JsonObject {
  operation_id: string;
  segmentation: SegmentationResource;
  prediction?: LayerPrediction;
}

export interface PredictedSegmentationPreview extends JsonObject {
  operation_id: string;
  status: "awaiting_layer_review";
  prediction: LayerPrediction;
  credit_boundary: {
    segmentation_credits: 5;
    submission_started: false;
  };
  resume: {
    operation_id: string;
    required_flag: "--accept-predicted-layers";
  };
}

export interface WaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  progress?: (message: string) => void;
}

export class SeglyService {
  constructor(
    readonly api: ApiClient,
    private readonly journal = new OperationJournal(),
  ) {}

  async capabilities(): Promise<JsonObject> {
    return asObject(
      await this.api.get<JsonObject>("/v1/capabilities", {
        authenticated: false,
      }),
      "capabilities",
    );
  }

  async paymentCapabilities(): Promise<JsonObject> {
    return asObject(
      await this.api.get<JsonObject>("/v1/payment-capabilities", {
        authenticated: false,
      }),
      "payment capabilities",
    );
  }

  async createMachineAccount(options: {
    packId: string;
    termsHash: string;
    operationId?: string;
    progress?: (message: string) => void;
  }): Promise<JsonObject> {
    if (!/^[a-f0-9]{64}$/iu.test(options.termsHash)) {
      throw new CliError(
        "--terms-hash must be a 64-character SHA-256 hex digest",
        {
          code: "invalid_terms_hash",
        },
      );
    }
    const operationId = options.operationId ?? newOperationId();
    const pendingId = `pending:${operationId}`;
    let recoverySecret = await resolveRecoverySecret(pendingId);
    if (!recoverySecret) {
      recoverySecret = randomBytes(32).toString("base64url");
      await storeRecoverySecret(pendingId, recoverySecret);
    }
    const recoveryHash = createHash("sha256")
      .update(recoverySecret)
      .digest("hex");
    const operation = await this.journal.open(
      operationId,
      fingerprint({
        pack_id: options.packId,
        terms_hash: options.termsHash.toLowerCase(),
        recovery_secret_hash: recoveryHash,
      }),
    );
    options.progress?.(`machine enrollment operation ${operationId} prepared`);
    const response = asObject(
      await this.api.post<JsonObject>("/v1/machine-accounts/bootstrap", {
        authenticated: false,
        body: {
          pack_id: options.packId,
          recovery_secret_hash: recoveryHash,
          terms_hash: options.termsHash.toLowerCase(),
        },
        headers: { "Idempotency-Key": operation.idempotency_key },
        retryable: true,
      }),
      "machine account",
    );
    const machineId = requiredString(
      response.id ?? response.machine_id,
      "machine account ID",
    );
    const apiKey = returnedApiKey(response);
    if (!apiKey) {
      throw new CliError(
        "Machine account response did not include its one-time API key",
        {
          code: "invalid_api_response",
        },
      );
    }
    const credentialStore = await storeApiKey(apiKey);
    await storeRecoverySecret(machineId, recoverySecret);
    await clearRecoverySecret(pendingId);
    await this.journal.update(operationId, { resource_id: machineId });
    return {
      operation_id: operationId,
      ...withoutCredentialSecrets(response),
      authenticated: true,
      credential_store: credentialStore,
      recovery_secret_stored: true,
    };
  }

  async recoverMachineAccount(options: {
    machineId: string;
    recoverySecret?: string;
    operationId?: string;
  }): Promise<JsonObject> {
    const recoverySecret =
      options.recoverySecret ??
      (await resolveRecoverySecret(options.machineId));
    if (!recoverySecret) {
      throw new CliError(
        "No recovery secret is stored; pipe it into `segly auth recover`",
        {
          code: "recovery_secret_required",
          exitCode: 3,
        },
      );
    }
    const operationId = options.operationId ?? newOperationId();
    const operation = await this.journal.open(
      operationId,
      fingerprint({
        machine_id: options.machineId,
        recovery_secret_hash: createHash("sha256")
          .update(recoverySecret)
          .digest("hex"),
      }),
    );
    const response = asObject(
      await this.api.post<JsonObject>(
        `/v1/machine-accounts/${encodeURIComponent(options.machineId)}/recover`,
        {
          authenticated: false,
          body: { recovery_secret: recoverySecret },
          headers: { "Idempotency-Key": operation.idempotency_key },
          retryable: true,
        },
      ),
      "machine recovery",
    );
    const apiKey = returnedApiKey(response);
    if (!apiKey) {
      throw new CliError(
        "Machine recovery response did not include its one-time API key",
        {
          code: "invalid_api_response",
        },
      );
    }
    const newRecovery =
      typeof response.recovery_secret === "string"
        ? response.recovery_secret
        : recoverySecret;
    const credentialStore = await storeApiKey(apiKey);
    await storeRecoverySecret(options.machineId, newRecovery);
    await this.journal.update(operationId, { resource_id: options.machineId });
    return {
      operation_id: operationId,
      ...withoutCredentialSecrets(response),
      authenticated: true,
      credential_store: credentialStore,
      recovery_secret_stored: true,
    };
  }

  async uploadPrepared(image: PreparedImage): Promise<UploadResource> {
    const created = asObject(
      await this.api.post<JsonObject>("/v1/uploads", {
        body: {
          filename: image.filename,
          content_type: image.contentType,
          size_bytes: image.bytes.length,
          sha256: image.sha256,
        },
      }),
      "upload",
    );
    const upload = asObject(created.upload as JsonValue, "signed upload");
    const method = requiredString(upload.method, "upload.method");
    if (method !== "PUT") {
      throw new CliError("Segly API requested an unsupported upload method", {
        code: "invalid_api_response",
      });
    }
    const uploadUrl = requiredString(upload.url, "upload.url");
    const headers = stringRecord(upload.headers);
    if (
      !Object.keys(headers).some(
        (name) => name.toLowerCase() === "content-type",
      )
    ) {
      headers["content-type"] = image.contentType;
    }
    await this.api.putSigned(uploadUrl, image.bytes, headers);
    const id = requiredString(created.id, "upload.id");
    return (await this.api.post<UploadResource>(
      `/v1/uploads/${encodeURIComponent(id)}/complete`,
      {
        body: {},
        retryable: true,
      },
    )) as UploadResource;
  }

  async uploadImage(path: string): Promise<UploadResource> {
    return await this.uploadPrepared(await prepareImage(path));
  }

  async predictLayersForUpload(
    uploadId: string,
    workflow: Workflow,
  ): Promise<LayerPrediction> {
    const response = await this.api.post<LayerPrediction>(
      "/v1/layer-predictions",
      {
        body: { upload_id: uploadId, workflow },
      },
    );
    const layers = Array.isArray(response.layers)
      ? response.layers.filter(
          (layer): layer is string => typeof layer === "string",
        )
      : [];
    return { ...response, layers: validateLayers(layers) };
  }

  async predictLayers(
    path: string,
    workflow: Workflow,
  ): Promise<LayerPrediction> {
    const upload = await this.uploadImage(path);
    return await this.predictLayersForUpload(upload.id, workflow);
  }

  private async principalFingerprint(): Promise<string> {
    return await this.api.credentialFingerprint();
  }

  async previewPredictedSegmentation(
    imagePath: string,
    options: Pick<
      CreateSegmentationOptions,
      "workflow" | "maxCredits" | "operationId" | "progress"
    >,
  ): Promise<PredictedSegmentationPreview> {
    assertCreditGuards(1, options.maxCredits, options.maxCredits);
    const image = await prepareImage(imagePath);
    const operationId = options.operationId ?? newOperationId();
    const requestFingerprint = fingerprint({
      principal: await this.principalFingerprint(),
      image_sha256: image.sha256,
      workflow: options.workflow,
      layers: undefined,
      predict_layers: true,
      max_credits: options.maxCredits,
    });
    let operation = await this.journal.open(operationId, requestFingerprint);
    options.progress?.(`operation ${operationId} prepared`);
    if (operation.job_id) {
      throw new CliError(
        "This prediction operation has already submitted a segmentation",
        { code: "operation_already_submitted" },
      );
    }
    if (!operation.upload_id) {
      options.progress?.("uploading private input");
      const upload = await this.uploadPrepared(image);
      operation = await this.journal.update(operationId, {
        upload_id: upload.id,
      });
    }
    const uploadId = requiredString(operation.upload_id, "operation.upload_id");

    let prediction: LayerPrediction;
    if (operation.layers && operation.prediction_source) {
      prediction = {
        workflow: options.workflow,
        layers: validateLayers(operation.layers),
        source: operation.prediction_source,
        credits: 0,
      };
    } else {
      options.progress?.("predicting layers for zero credits");
      prediction = await this.predictLayersForUpload(uploadId, options.workflow);
      operation = await this.journal.update(operationId, {
        layers: prediction.layers,
        prediction_source: prediction.source,
      });
    }

    return {
      operation_id: operationId,
      status: "awaiting_layer_review",
      prediction,
      credit_boundary: {
        segmentation_credits: SEGMENTATION_CREDIT_COST,
        submission_started: false,
      },
      resume: {
        operation_id: operationId,
        required_flag: "--accept-predicted-layers",
      },
    };
  }

  async createSegmentation(
    imagePath: string,
    options: CreateSegmentationOptions,
  ): Promise<CreateSegmentationResult> {
    assertCreditGuards(1, options.maxCredits, options.maxCredits);
    if (!!options.layers === !!options.predictLayers) {
      throw new CliError(
        "Choose either explicit --layer values or --predict-layers",
        {
          code: "layer_mode_required",
        },
      );
    }
    if (options.predictLayers && !options.acceptPredictedLayers) {
      throw new CliError(
        "Predicted layers must be previewed before paid submission",
        {
          code: "predicted_layers_review_required",
        },
      );
    }
    const explicitLayers = options.layers
      ? validateLayers(options.layers)
      : undefined;
    const image = await prepareImage(imagePath);
    const operationId = options.operationId ?? newOperationId();
    const requestFingerprint = fingerprint({
      principal: await this.principalFingerprint(),
      image_sha256: image.sha256,
      workflow: options.workflow,
      layers: explicitLayers,
      predict_layers: options.predictLayers ?? false,
      max_credits: options.maxCredits,
    });
    let operation = await this.journal.open(operationId, requestFingerprint);
    options.progress?.(`operation ${operationId} prepared`);

    if (operation.job_id) {
      return {
        operation_id: operationId,
        segmentation: await this.getSegmentation(operation.job_id),
      };
    }

    if (!operation.upload_id) {
      options.progress?.("uploading private input");
      const upload = await this.uploadPrepared(image);
      operation = await this.journal.update(operationId, {
        upload_id: upload.id,
      });
    }
    const uploadId = requiredString(operation.upload_id, "operation.upload_id");

    let prediction: LayerPrediction | undefined;
    let layers = operation.layers ?? explicitLayers;
    if (!layers && options.predictLayers) {
      options.progress?.("predicting layers for zero credits");
      prediction = await this.predictLayersForUpload(
        uploadId,
        options.workflow,
      );
      layers = prediction.layers;
      operation = await this.journal.update(operationId, {
        layers,
        prediction_source: prediction.source,
      });
    }
    if (!layers) {
      throw new CliError("No layers were supplied", { code: "invalid_layers" });
    }
    layers = validateLayers(layers);
    if (!operation.layers)
      operation = await this.journal.update(operationId, { layers });

    options.progress?.(
      `submitting one ${SEGMENTATION_CREDIT_COST}-credit segmentation`,
    );
    const segmentation = await this.api.post<SegmentationResource>(
      "/v1/segmentations",
      {
        body: {
          upload_id: uploadId,
          workflow: options.workflow,
          layers,
          max_credits: SEGMENTATION_CREDIT_COST,
        },
        headers: { "Idempotency-Key": operation.idempotency_key },
        retryable: true,
      },
    );
    const id = requiredString(segmentation.id, "segmentation.id");
    await this.journal.update(operationId, { job_id: id });
    return {
      operation_id: operationId,
      segmentation,
      ...(prediction ? { prediction } : {}),
    };
  }

  async getSegmentation(id: string): Promise<SegmentationResource> {
    return await this.api.get<SegmentationResource>(
      `/v1/segmentations/${encodeURIComponent(id)}`,
    );
  }

  private async getSegmentationForPolling(
    id: string,
  ): Promise<{
    resource: SegmentationResource;
    retryAfterMs: number | undefined;
  }> {
    let retryAfterMs: number | undefined;
    const resource = await this.api.get<SegmentationResource>(
      `/v1/segmentations/${encodeURIComponent(id)}`,
      {
        onResponse: (metadata) => {
          retryAfterMs = metadata.retryAfterMs;
        },
      },
    );
    return { resource, retryAfterMs };
  }

  async listSegmentations(limit = 20, cursor?: string): Promise<PageResource> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return await this.api.get<PageResource>(
      `/v1/segmentations?${query.toString()}`,
    );
  }

  async cancelSegmentation(id: string): Promise<SegmentationResource> {
    return await this.api.post<SegmentationResource>(
      `/v1/segmentations/${encodeURIComponent(id)}/cancel`,
      { body: {}, retryable: true },
    );
  }

  async waitForSegmentation(
    id: string,
    options: WaitOptions = {},
  ): Promise<SegmentationResource> {
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    const deadline = Date.now() + timeoutMs;
    let previousStatus: string | undefined;
    while (Date.now() < deadline) {
      const polling = await this.getSegmentationForPolling(id);
      const resource = polling.resource;
      const status =
        resource.status === "completed" ? "succeeded" : resource.status;
      if (status !== previousStatus) {
        options.progress?.(`segmentation status: ${status}`);
        previousStatus = status;
      }
      if (["succeeded", "failed", "cancelled"].includes(status))
        return resource;
      const requestedDelay =
        polling.retryAfterMs ??
        (typeof resource.retry_after_ms === "number"
          ? resource.retry_after_ms
          : undefined);
      await sleep(
        Math.min(requestedDelay ?? options.pollIntervalMs ?? 2_000, 10_000),
      );
    }
    throw new CliError("Timed out waiting for segmentation", {
      code: "wait_timeout",
      exitCode: 2,
      details: { segmentation_id: id, timeout_ms: timeoutMs },
    });
  }

  async prepareArtifact(
    id: string,
    kind: string,
    retry = false,
  ): Promise<ArtifactResource> {
    return await this.api.post<ArtifactResource>(
      `/v1/segmentations/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(kind)}/prepare`,
      { body: { retry }, retryable: true },
    );
  }

  async getArtifact(id: string, kind: string): Promise<ArtifactResource> {
    return await this.api.get<ArtifactResource>(
      `/v1/segmentations/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(kind)}`,
    );
  }

  async waitForArtifact(
    id: string,
    kind: string,
    options: WaitOptions = {},
  ): Promise<ArtifactResource> {
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const artifact = await this.getArtifact(id, kind);
      if (["ready", "succeeded"].includes(artifact.status)) return artifact;
      if (artifact.status === "failed") {
        throw new CliError(artifact.message ?? "Artifact preparation failed", {
          code: "artifact_failed",
          exitCode: 2,
        });
      }
      await sleep(
        Math.min(
          artifact.retry_after_ms ?? options.pollIntervalMs ?? 1_500,
          10_000,
        ),
      );
    }
    throw new CliError("Timed out waiting for artifact", {
      code: "wait_timeout",
      exitCode: 2,
    });
  }

  async downloadArtifact(
    id: string,
    kind: string,
    output: string | undefined,
    options: WaitOptions & {
      directory?: boolean;
      force?: boolean;
      retry?: boolean;
    } = {},
  ): Promise<DownloadResult> {
    options.progress?.("preparing artifact");
    let artifact = await this.prepareArtifact(id, kind, options.retry ?? false);
    if (!["ready", "succeeded"].includes(artifact.status)) {
      artifact = await this.waitForArtifact(id, kind, options);
    }
    if (!artifact.url) {
      throw new CliError("Prepared artifact did not include a download URL", {
        code: "invalid_api_response",
      });
    }
    if (
      typeof artifact.sha256 !== "string" ||
      !/^(?:sha256:)?[a-f0-9]{64}$/iu.test(artifact.sha256)
    ) {
      throw new CliError("Prepared artifact did not include a valid SHA-256 checksum", {
        code: "invalid_api_response",
      });
    }
    if (
      typeof artifact.size_bytes !== "number" ||
      !Number.isSafeInteger(artifact.size_bytes) ||
      artifact.size_bytes < 0
    ) {
      throw new CliError("Prepared artifact did not include a valid byte size", {
        code: "invalid_api_response",
      });
    }
    if (
      typeof artifact.expires_at !== "string" ||
      !Number.isFinite(Date.parse(artifact.expires_at))
    ) {
      throw new CliError("Prepared artifact did not include an absolute expiry", {
        code: "invalid_api_response",
      });
    }
    let outputPath =
      output ?? artifactFilename(id, kind, artifact.content_type);
    if (options.directory) {
      outputPath = join(
        outputPath,
        artifactFilename(id, kind, artifact.content_type),
      );
    } else if (output) {
      const metadata = await stat(output).catch(() => undefined);
      if (metadata?.isDirectory()) {
        outputPath = join(
          output,
          artifactFilename(id, kind, artifact.content_type),
        );
      }
    }
    options.progress?.("downloading and verifying artifact");
    return await atomicDownload(
      await this.api.getSigned(artifact.url),
      outputPath,
      artifact.sha256,
      options.force ?? false,
      artifact.size_bytes,
    );
  }

  async creditBalance(): Promise<JsonObject> {
    return asObject(
      await this.api.get<JsonObject>("/v1/credits/balance"),
      "credit balance",
    );
  }

  async creditHistory(limit = 20, cursor?: string): Promise<PageResource> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return await this.api.get<PageResource>(
      `/v1/credits/transactions?${query.toString()}`,
    );
  }

  async creditPacks(): Promise<JsonObject> {
    return asObject(
      await this.api.get<JsonObject>("/v1/credit-packs", {
        authenticated: false,
      }),
      "credit packs",
    );
  }

  async buyCredits(options: {
    packId: string;
    method: "machine" | "hosted";
    maxPriceCents: number;
    operationId?: string;
    returnPath?: string;
    progress?: (message: string) => void;
  }): Promise<JsonObject> {
    const packs = await this.creditPacks();
    const items = Array.isArray(packs.items) ? packs.items : [];
    const pack = items.find(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        item.id === options.packId,
    ) as JsonObject | undefined;
    if (!pack)
      throw new CliError("Unknown credit pack", {
        code: "unknown_credit_pack",
      });
    const price = pack.price_cents;
    if (typeof price !== "number" || price > options.maxPriceCents) {
      throw new CliError("Credit pack exceeds the approved maximum price", {
        code: "purchase_limit_exceeded",
        exitCode: 4,
        details: { price_cents: price, max_price_cents: options.maxPriceCents },
      });
    }
    const operationId = options.operationId ?? newOperationId();
    const operation = await this.journal.open(
      operationId,
      fingerprint({
        principal: await this.principalFingerprint(),
        pack_id: options.packId,
        method: options.method,
        max_price_cents: options.maxPriceCents,
      }),
    );
    options.progress?.(`purchase operation ${operationId} prepared`);
    const path =
      options.method === "hosted"
        ? "/v1/credit-purchases/checkout"
        : "/v1/credit-purchases";
    const response = asObject(
      await this.api.post<JsonObject>(path, {
        body: {
          pack_id: options.packId,
          max_price_cents: options.maxPriceCents,
          ...(options.returnPath ? { return_path: options.returnPath } : {}),
        },
        headers: { "Idempotency-Key": operation.idempotency_key },
        retryable: true,
      }),
      "credit purchase",
    );
    const resourceId =
      typeof response.id === "string"
        ? response.id
        : typeof response.session_id === "string"
          ? response.session_id
          : undefined;
    if (resourceId)
      await this.journal.update(operationId, { resource_id: resourceId });
    return { operation_id: operationId, ...response };
  }

  async listWebhooks(): Promise<JsonObject> {
    const response = await this.api.get<JsonValue>("/v1/webhooks");
    if (Array.isArray(response)) return { items: response };
    return asObject(response, "webhooks");
  }

  async createWebhook(url: string, events: string[]): Promise<JsonObject> {
    const response = asObject(
      await this.api.post<JsonObject>("/v1/webhooks", {
        body: { url, events },
      }),
      "webhook",
    );
    const webhook = asObject(response.webhook as JsonValue, "webhook");
    const id = requiredString(webhook.id, "webhook.id");
    const secret = requiredString(response.secret, "webhook.secret");
    const secretStore = await storeWebhookSecret(id, secret);
    return {
      webhook,
      secret_stored: true,
      secret_store: secretStore,
    };
  }

  async deleteWebhook(id: string): Promise<JsonObject> {
    await this.api.delete<JsonValue>(`/v1/webhooks/${encodeURIComponent(id)}`);
    await clearWebhookSecret(id);
    return { deleted: true, id, secret_deleted: true };
  }

  async testWebhook(id: string): Promise<JsonObject> {
    return asObject(
      await this.api.post<JsonObject>(
        `/v1/webhooks/${encodeURIComponent(id)}/test`,
        {
          body: {},
        },
      ),
      "webhook delivery",
    );
  }
}
