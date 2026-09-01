import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  SEGMENTATION_CREDIT_COST,
  SeglyService,
  validateWorkflow,
} from "./service.js";
import type { JsonValue } from "./types.js";

function serializable(value: unknown): Record<string, unknown> {
  const parsed = JSON.parse(JSON.stringify(value)) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return { value: parsed };
}

function sanitizeSensitiveOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSensitiveOutput);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          !/(?:^|_)(?:api_?key|access_?token|refresh_?token|recovery_?secret|payment_?credential|secret|signed_?url|upload_?url|checkout_?url|session_?id|file_?name|filename)$/iu.test(
            key,
          ),
      )
      .map(([key, item]) => [key, sanitizeSensitiveOutput(item)]),
  );
}

function withoutSignedUrl(value: unknown): Record<string, unknown> {
  const safe = serializable(sanitizeSensitiveOutput(value));
  delete safe.url;
  return safe;
}

function result(
  value: unknown,
  removeSignedUrl = false,
  clientMeta?: Record<string, unknown>,
) {
  const structuredContent = removeSignedUrl
    ? withoutSignedUrl(value)
    : serializable(sanitizeSensitiveOutput(value));
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(structuredContent) },
    ],
    structuredContent,
    ...(clientMeta ? { _meta: clientMeta } : {}),
  };
}

function purchaseResult(value: unknown) {
  const raw = serializable(value);
  const checkoutUrl =
    typeof raw.checkout_url === "string" ? raw.checkout_url : undefined;
  const sessionId =
    typeof raw.session_id === "string" ? raw.session_id : undefined;
  return result(
    value,
    true,
    checkoutUrl
      ? {
          "io.segly/checkout": {
            url: checkoutUrl,
            ...(sessionId ? { session_id: sessionId } : {}),
          },
        }
      : undefined,
  );
}

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function buildMcpServer(service: SeglyService): McpServer {
  const server = new McpServer(
    {
      name: "segly",
      version: "0.1.0",
      websiteUrl: "https://segly.io/agents",
    },
    { capabilities: { logging: {} } },
  );

  server.registerTool(
    "get_capabilities",
    {
      title: "Get Segly capabilities",
      description:
        "Read current Segly image formats, workflows, output types, limits, latency, retention, price, and documentation links.",
      annotations: readAnnotations,
    },
    async () => result(await service.capabilities()),
  );

  server.registerTool(
    "get_credit_balance",
    {
      title: "Get Segly credit balance",
      description:
        "Read the authenticated Segly account's prepaid credit balance.",
      annotations: readAnnotations,
    },
    async () => result(await service.creditBalance()),
  );

  server.registerTool(
    "list_credit_packs",
    {
      title: "List Segly credit packs",
      description:
        "Read the current fixed credit-pack SKUs and prices without purchasing anything.",
      annotations: readAnnotations,
    },
    async () => result(await service.creditPacks()),
  );

  server.registerTool(
    "upload_image",
    {
      title: "Upload an image privately",
      description:
        "Upload one local PNG, JPEG, or WebP image to a short-lived private Segly upload. This does not spend credits.",
      inputSchema: z.object({
        image_path: z
          .string()
          .min(1)
          .describe("Absolute or working-directory-relative local image path"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ image_path }) =>
      result(await service.uploadImage(image_path), true),
  );

  server.registerTool(
    "predict_layers",
    {
      title: "Predict Segly layers",
      description:
        "Upload a local image and predict explicit named layers for a Segly workflow. Prediction costs zero credits and does not start segmentation.",
      inputSchema: z.object({
        image_path: z
          .string()
          .min(1)
          .describe("Local PNG, JPEG, or WebP image path"),
        workflow: z
          .string()
          .describe("Workflow ID returned by get_capabilities"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ image_path, workflow }) =>
      result(
        await service.predictLayers(image_path, validateWorkflow(workflow)),
      ),
  );

  server.registerTool(
    "create_segmentation",
    {
      title: "Create a Segly segmentation",
      description:
        "Spend exactly 5 prepaid credits to submit one asynchronous segmentation with an explicit reviewed layer list. The operation ID makes retries idempotent.",
      inputSchema: z.object({
        image_path: z
          .string()
          .min(1)
          .describe("Local PNG, JPEG, or WebP image path"),
        workflow: z
          .string()
          .describe("Workflow ID returned by get_capabilities"),
        layers: z.array(z.string().min(1).max(64)).min(1).max(32),
        max_credits: z.literal(SEGMENTATION_CREDIT_COST),
        operation_id: z
          .string()
          .min(8)
          .max(255)
          .describe(
            "Caller-generated stable ID that must be reused after an interrupted call",
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ image_path, workflow, layers, max_credits, operation_id }) =>
      result(
        await service.createSegmentation(image_path, {
          workflow: validateWorkflow(workflow),
          layers,
          maxCredits: max_credits,
          operationId: operation_id,
        }),
      ),
  );

  server.registerTool(
    "get_segmentation",
    {
      title: "Get a Segly segmentation",
      description:
        "Read one segmentation's current status, credit state, and result metadata.",
      inputSchema: z.object({ segmentation_id: z.string().min(1) }),
      annotations: readAnnotations,
    },
    async ({ segmentation_id }) =>
      result(await service.getSegmentation(segmentation_id)),
  );

  server.registerTool(
    "list_segmentations",
    {
      title: "List Segly segmentations",
      description:
        "Read a cursor-paginated page of the authenticated account's segmentations.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().optional(),
      }),
      annotations: readAnnotations,
    },
    async ({ limit, cursor }) =>
      result(await service.listSegmentations(limit, cursor)),
  );

  server.registerTool(
    "cancel_segmentation",
    {
      title: "Cancel a queued Segly segmentation",
      description:
        "Cancel a segmentation only while it is still queued. Processing segmentations cannot be cancelled.",
      inputSchema: z.object({ segmentation_id: z.string().min(1) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ segmentation_id }) =>
      result(await service.cancelSegmentation(segmentation_id)),
  );

  server.registerTool(
    "prepare_artifact",
    {
      title: "Prepare a Segly artifact",
      description:
        "Idempotently request preparation of a ZIP, mask, Spine PSD, Live2D PSD, or another supported artifact. Signed URLs are not exposed in tool output.",
      inputSchema: z.object({
        segmentation_id: z.string().min(1),
        kind: z.string().min(1),
        retry: z.boolean().default(false),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ segmentation_id, kind, retry }) =>
      result(await service.prepareArtifact(segmentation_id, kind, retry), true),
  );

  server.registerTool(
    "download_artifact",
    {
      title: "Download and verify a Segly artifact",
      description:
        "Prepare, download atomically, and SHA-256 verify an artifact to the local filesystem.",
      inputSchema: z.object({
        segmentation_id: z.string().min(1),
        kind: z.string().min(1),
        output_path: z.string().optional(),
        timeout_seconds: z.number().int().min(1).max(1800).default(300),
        retry: z.boolean().default(false),
        force: z.boolean().default(false),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      segmentation_id,
      kind,
      output_path,
      timeout_seconds,
      retry,
      force,
    }) =>
      result(
        await service.downloadArtifact(segmentation_id, kind, output_path, {
          timeoutMs: timeout_seconds * 1000,
          retry,
          force,
        }),
      ),
  );

  server.registerTool(
    "begin_credit_purchase",
    {
      title: "Begin an explicit Segly credit purchase",
      description:
        "Purchase one exact credit pack only after explicit authorization. This tool is never called automatically after insufficient credits.",
      inputSchema: z.object({
        pack_id: z.string().min(1),
        method: z.enum(["machine", "hosted"]),
        max_price_cents: z.number().int().positive(),
        confirmed: z
          .literal(true)
          .describe("Must be true only after explicit purchase authorization"),
        operation_id: z
          .string()
          .min(4)
          .max(128)
          .describe(
            "Caller-generated stable ID that must be reused after an interrupted call",
          ),
        return_path: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ pack_id, method, max_price_cents, operation_id, return_path }) =>
      purchaseResult(
        await service.buyCredits({
          packId: pack_id,
          method,
          maxPriceCents: max_price_cents,
          operationId: operation_id,
          ...(return_path ? { returnPath: return_path } : {}),
        }),
      ),
  );

  return server;
}

export async function startMcpServer(service: SeglyService): Promise<void> {
  serveStdio(() => buildMcpServer(service));
}
