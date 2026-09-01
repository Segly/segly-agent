import { randomUUID } from "node:crypto";
import { Command, CommanderError, Option } from "commander";
import { ApiClient } from "./api.js";
import {
  clearApiKey,
  resolveApiUrl,
  resolveCredential,
  resolveRecoverySecret,
  storeApiKey,
} from "./config.js";
import { CliError } from "./errors.js";
import { readLayersFile } from "./layers-file.js";
import { createOutputWriter, type OutputWriter } from "./output.js";
import {
  assertCreditGuards,
  SEGMENTATION_CREDIT_COST,
  SeglyService,
  validateLayers,
  validateWorkflow,
  WORKFLOWS,
} from "./service.js";
import type { JsonObject } from "./types.js";

interface GlobalOptions {
  apiUrl?: string;
  requestTimeout: number;
  retries: number;
  input: boolean;
}

interface Runtime {
  output: OutputWriter;
  stdin: NodeJS.ReadStream;
  stderr: NodeJS.WritableStream;
}

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CliError("Expected a non-negative integer", {
      code: "invalid_argument",
    });
  }
  return parsed;
}

function positiveInteger(value: string): number {
  const parsed = integer(value);
  if (parsed < 1) {
    throw new CliError("Expected a positive integer", {
      code: "invalid_argument",
    });
  }
  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function splitEvents(values: string[]): string[] {
  return [
    ...new Set(
      values
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function promptHidden(
  stdin: NodeJS.ReadStream,
  stderr: NodeJS.WritableStream,
): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function")
    return await readAll(stdin);
  stderr.write("Segly API key: ");
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          finish(
            new CliError("Authentication input cancelled", {
              code: "cancelled",
              exitCode: 130,
            }),
          );
          return;
        }
        if (byte === 10 || byte === 13) {
          finish();
          return;
        }
        if (byte === 8 || byte === 127) {
          const last = chunks.pop();
          if (last && last.length > 1) chunks.push(last.subarray(0, -1));
          continue;
        }
        chunks.push(Buffer.from([byte]));
      }
    };
    stdin.on("data", onData);
  });
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        const value = values[index];
        if (value === undefined) return;
        results[index] = await worker(value, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function createCli(runtimeOverrides: Partial<Runtime> = {}): Command {
  const runtime: Runtime = {
    output: runtimeOverrides.output ?? createOutputWriter(),
    stdin: runtimeOverrides.stdin ?? process.stdin,
    stderr: runtimeOverrides.stderr ?? process.stderr,
  };
  const program = new Command();
  program
    .name("segly")
    .description("Agent-friendly CLI and local MCP server for Segly")
    .version("0.1.0")
    .option("--api-url <url>", "Segly API base URL")
    .option(
      "--json",
      "emit JSON on stdout (the default; accepted for explicit automation)",
    )
    .option(
      "--request-timeout <seconds>",
      "timeout for each HTTP request",
      positiveInteger,
      30,
    )
    .option(
      "--retries <count>",
      "bounded retries for safe requests",
      integer,
      2,
    )
    .option("--no-input", "never prompt for input");

  const getService = async (): Promise<SeglyService> => {
    const options = program.opts<GlobalOptions>();
    return new SeglyService(
      new ApiClient({
        baseUrl: await resolveApiUrl(options.apiUrl),
        timeoutMs: options.requestTimeout * 1000,
        maxRetries: options.retries,
      }),
    );
  };

  program
    .command("capabilities")
    .description("Show Segly workflows, limits, formats, pricing, and links")
    .action(async () =>
      runtime.output.result(await (await getService()).capabilities()),
    );

  const auth = program
    .command("auth")
    .description("Manage Segly authentication");
  auth
    .command("login")
    .description(
      "Sign in with OAuth 2.1 authorization code, PKCE, and dynamic registration",
    )
    .option(
      "--no-open",
      "print the authorization URL instead of opening a browser",
    )
    .option(
      "--timeout <seconds>",
      "bounded authorization wait",
      positiveInteger,
      300,
    )
    .action(async (options: { open: boolean; timeout: number }) => {
      const { loginWithOAuth } = await import("./oauth.js");
      const global = program.opts<GlobalOptions>();
      runtime.output.result(
        await loginWithOAuth({
          apiUrl: await resolveApiUrl(global.apiUrl),
          timeoutMs: options.timeout * 1000,
          open: options.open,
          progress: runtime.output.progress,
        }),
      );
    });
  auth
    .command("use-key")
    .description(
      "Securely store a key from SEGLY_API_KEY, stdin, or a hidden prompt",
    )
    .action(async () => {
      const global = program.opts<GlobalOptions>();
      let key = process.env.SEGLY_API_KEY?.trim();
      if (!key) {
        if (!global.input && runtime.stdin.isTTY) {
          throw new CliError(
            "--no-input requires SEGLY_API_KEY or piped stdin",
            {
              code: "authentication_required",
              exitCode: 3,
            },
          );
        }
        key = (await promptHidden(runtime.stdin, runtime.stderr)).trim();
      }
      const store = await storeApiKey(key);
      runtime.output.result({ authenticated: true, credential_store: store });
    });
  auth
    .command("status")
    .description("Verify the configured key and show credit balance")
    .action(async () => {
      const credential = await resolveCredential();
      const balance = await (await getService()).creditBalance();
      runtime.output.result({
        authenticated: true,
        credential_source: credential.source,
        ...balance,
      });
    });
  auth
    .command("logout")
    .description("Remove the locally stored key")
    .action(async () => {
      await clearApiKey();
      runtime.output.result({ authenticated: false });
    });
  auth
    .command("recover")
    .description(
      "Recover a dark-gated machine account with its separately stored secret",
    )
    .argument("<machine-id>", "machine account ID")
    .option(
      "--recovery-secret-stdin",
      "read a recovery secret from stdin or a hidden prompt",
    )
    .option("--operation-id <id>", "resume an interrupted recovery")
    .action(
      async (
        machineId: string,
        options: { recoverySecretStdin?: boolean; operationId?: string },
      ) => {
        let recoverySecret = await resolveRecoverySecret(machineId);
        if (options.recoverySecretStdin || !recoverySecret) {
          const global = program.opts<GlobalOptions>();
          if (!global.input && runtime.stdin.isTTY) {
            throw new CliError(
              "--no-input requires a stored or piped recovery secret",
              {
                code: "recovery_secret_required",
                exitCode: 3,
              },
            );
          }
          recoverySecret = (
            await promptHidden(runtime.stdin, runtime.stderr)
          ).trim();
        }
        runtime.output.result(
          await (
            await getService()
          ).recoverMachineAccount({
            machineId,
            ...(recoverySecret ? { recoverySecret } : {}),
            ...(options.operationId
              ? { operationId: options.operationId }
              : {}),
          }),
        );
      },
    );

  const machine = program
    .command("machine")
    .description("Create dark-gated machine accounts");
  machine
    .command("create")
    .description(
      "Begin an idempotent machine enrollment and store recovery material separately",
    )
    .requiredOption("--pack <pack-id>", "exact credit-pack ID")
    .requiredOption(
      "--terms-hash <sha256>",
      "accepted terms document SHA-256 hex digest",
    )
    .option("--operation-id <id>", "resume an interrupted enrollment")
    .action(
      async (options: {
        pack: string;
        termsHash: string;
        operationId?: string;
      }) =>
        runtime.output.result(
          await (
            await getService()
          ).createMachineAccount({
            packId: options.pack,
            termsHash: options.termsHash,
            ...(options.operationId
              ? { operationId: options.operationId }
              : {}),
            progress: runtime.output.progress,
          }),
        ),
    );

  const layers = program
    .command("layers")
    .description("Predict named layers without spending credits");
  layers
    .command("predict")
    .description("Upload an image and predict layers for zero credits")
    .argument("<image>", "local PNG, JPEG, or WebP path")
    .requiredOption("--workflow <workflow>", `one of: ${WORKFLOWS.join(", ")}`)
    .action(async (image: string, options: { workflow: string }) => {
      runtime.output.progress("uploading private input");
      const prediction = await (
        await getService()
      ).predictLayers(image, validateWorkflow(options.workflow));
      runtime.output.result(prediction);
    });

  const segment = program
    .command("segment")
    .description("Create and manage segmentations");
  segment
    .command("create")
    .description("Create one idempotent asynchronous segmentation per image")
    .argument("<images...>", "one or more local image paths")
    .requiredOption("--workflow <workflow>", `one of: ${WORKFLOWS.join(", ")}`)
    .option(
      "--layer <name>",
      "explicit layer name; repeat for each layer",
      collect,
      [],
    )
    .option(
      "--layers-file <path>",
      "JSON array or newline-delimited explicit layers",
    )
    .option(
      "--predict-layers",
      "predict for zero credits and return the proposed list before submission",
    )
    .option(
      "--accept-predicted-layers",
      "submit a previously previewed prediction from the same operation",
    )
    .requiredOption(
      `--max-credits <credits>`,
      `must be ${SEGMENTATION_CREDIT_COST} for each job`,
      positiveInteger,
    )
    .option(
      "--max-total-credits <credits>",
      "required guard for multiple images",
      positiveInteger,
    )
    .option(
      "--operation-id <id>",
      "resume a journaled operation after interruption",
    )
    .option(
      "--concurrency <count>",
      "maximum simultaneous image operations",
      positiveInteger,
      2,
    )
    .option("--wait", "wait for a terminal segmentation status")
    .option(
      "--wait-timeout <seconds>",
      "bounded total wait",
      positiveInteger,
      600,
    )
    .option(
      "--download <directory>",
      "after success, download an artifact to this directory",
    )
    .option("--artifact <kind>", "artifact kind used by --download", "zip")
    .option("--force", "replace an existing download")
    .action(
      async (
        images: string[],
        options: {
          workflow: string;
          layer: string[];
          layersFile?: string;
          predictLayers?: boolean;
          acceptPredictedLayers?: boolean;
          maxCredits: number;
          maxTotalCredits?: number;
          operationId?: string;
          concurrency: number;
          wait?: boolean;
          waitTimeout: number;
          download?: string;
          artifact: string;
          force?: boolean;
        },
      ) => {
        if (options.download && !options.wait) {
          throw new CliError("--download requires --wait", {
            code: "invalid_argument",
          });
        }
        if (options.acceptPredictedLayers && !options.predictLayers) {
          throw new CliError(
            "--accept-predicted-layers requires --predict-layers",
            { code: "invalid_argument" },
          );
        }
        if (
          options.predictLayers &&
          !options.acceptPredictedLayers &&
          (options.wait || options.download)
        ) {
          throw new CliError(
            "Preview predicted layers first, then resume with --accept-predicted-layers before waiting or downloading",
            { code: "predicted_layers_review_required" },
          );
        }
        assertCreditGuards(
          images.length,
          options.maxCredits,
          options.maxTotalCredits,
        );
        const explicitModes =
          Number(options.layer.length > 0) + Number(!!options.layersFile);
        if (explicitModes > 1) {
          throw new CliError("Use --layer or --layers-file, not both", {
            code: "invalid_argument",
          });
        }
        if (explicitModes > 0 === !!options.predictLayers) {
          throw new CliError(
            "Choose explicit --layer values or --predict-layers",
            {
              code: "layer_mode_required",
            },
          );
        }
        const explicitLayers = options.layersFile
          ? await readLayersFile(options.layersFile)
          : options.layer.length > 0
            ? validateLayers(options.layer)
            : undefined;
        const service = await getService();
        const baseOperationId =
          options.operationId ?? `op_${randomUUID().replaceAll("-", "")}`;
        const results = await mapLimit(
          images,
          options.concurrency,
          async (image, index) => {
            const operationId =
              images.length === 1
                ? baseOperationId
                : `${baseOperationId}.${index + 1}`;
            if (options.predictLayers && !options.acceptPredictedLayers) {
              return await service.previewPredictedSegmentation(image, {
                workflow: validateWorkflow(options.workflow),
                maxCredits: options.maxCredits,
                operationId,
                progress: runtime.output.progress,
              });
            }
            const created = await service.createSegmentation(image, {
              workflow: validateWorkflow(options.workflow),
              ...(explicitLayers
                ? { layers: explicitLayers }
                : {
                    predictLayers: true,
                    acceptPredictedLayers: true,
                  }),
              maxCredits: options.maxCredits,
              operationId,
              progress: runtime.output.progress,
            });
            if (!options.wait) return created;
            const completed = await service.waitForSegmentation(
              created.segmentation.id,
              {
                timeoutMs: options.waitTimeout * 1000,
                progress: runtime.output.progress,
              },
            );
            let download: JsonObject | undefined;
            if (
              options.download &&
              ["succeeded", "completed"].includes(completed.status)
            ) {
              download = {
                ...(await service.downloadArtifact(
                  completed.id,
                  options.artifact,
                  options.download,
                  {
                    directory: true,
                    ...(options.force !== undefined
                      ? { force: options.force }
                      : {}),
                    timeoutMs: options.waitTimeout * 1000,
                    progress: runtime.output.progress,
                  },
                )),
              };
            }
            return {
              ...created,
              segmentation: completed,
              ...(download ? { download } : {}),
            };
          },
        );
        runtime.output.result(
          images.length === 1 ? results[0] : { items: results },
        );
      },
    );
  segment
    .command("get")
    .argument("<id>", "segmentation ID")
    .action(async (id: string) =>
      runtime.output.result(await (await getService()).getSegmentation(id)),
    );
  segment
    .command("list")
    .option("--limit <count>", "page size", positiveInteger, 20)
    .option("--cursor <cursor>", "next-page cursor")
    .action(async (options: { limit: number; cursor?: string }) =>
      runtime.output.result(
        await (
          await getService()
        ).listSegmentations(options.limit, options.cursor),
      ),
    );
  segment
    .command("wait")
    .argument("<id>", "segmentation ID")
    .option("--timeout <seconds>", "bounded total wait", positiveInteger, 600)
    .action(async (id: string, options: { timeout: number }) =>
      runtime.output.result(
        await (
          await getService()
        ).waitForSegmentation(id, {
          timeoutMs: options.timeout * 1000,
          progress: runtime.output.progress,
        }),
      ),
    );
  segment
    .command("cancel")
    .argument("<id>", "queued segmentation ID")
    .action(async (id: string) =>
      runtime.output.result(await (await getService()).cancelSegmentation(id)),
    );

  const artifact = program
    .command("artifact")
    .description("Prepare and download result artifacts");
  artifact
    .command("prepare")
    .argument("<id>", "segmentation ID")
    .argument("<kind>", "artifact kind")
    .option("--retry", "explicitly retry a failed preparation")
    .action(async (id: string, kind: string, options: { retry?: boolean }) => {
      const prepared = await (
        await getService()
      ).prepareArtifact(id, kind, options.retry);
      const { url: _signedUrl, ...safe } = prepared;
      runtime.output.result(safe);
    });
  artifact
    .command("download")
    .argument("<id>", "segmentation ID")
    .argument("<kind>", "artifact kind")
    .option("--output <path>", "output file or existing directory")
    .option(
      "--timeout <seconds>",
      "bounded artifact wait",
      positiveInteger,
      300,
    )
    .option("--retry", "explicitly retry a failed preparation")
    .option("--force", "replace an existing file")
    .action(
      async (
        id: string,
        kind: string,
        options: {
          output?: string;
          timeout: number;
          retry?: boolean;
          force?: boolean;
        },
      ) =>
        runtime.output.result(
          await (
            await getService()
          ).downloadArtifact(id, kind, options.output, {
            timeoutMs: options.timeout * 1000,
            ...(options.retry !== undefined ? { retry: options.retry } : {}),
            ...(options.force !== undefined ? { force: options.force } : {}),
            progress: runtime.output.progress,
          }),
        ),
    );

  const credits = program
    .command("credits")
    .description("Inspect credits and make explicit purchases");
  credits
    .command("balance")
    .action(async () =>
      runtime.output.result(await (await getService()).creditBalance()),
    );
  credits
    .command("history")
    .option("--limit <count>", "page size", positiveInteger, 20)
    .option("--cursor <cursor>", "next-page cursor")
    .action(async (options: { limit: number; cursor?: string }) =>
      runtime.output.result(
        await (await getService()).creditHistory(options.limit, options.cursor),
      ),
    );
  credits
    .command("packs")
    .action(async () =>
      runtime.output.result(await (await getService()).creditPacks()),
    );
  credits
    .command("buy")
    .argument("<pack-id>", "exact credit-pack ID")
    .addOption(
      new Option("--method <method>", "payment method")
        .choices(["machine", "hosted"])
        .default("hosted"),
    )
    .requiredOption(
      "--max-price-cents <amount>",
      "maximum authorized price",
      positiveInteger,
    )
    .option(
      "--operation-id <id>",
      "resume a journaled purchase after interruption",
    )
    .option("--return-path <path>", "same-site return path for hosted checkout")
    .action(
      async (
        packId: string,
        options: {
          method: "machine" | "hosted";
          maxPriceCents: number;
          operationId?: string;
          returnPath?: string;
        },
      ) =>
        runtime.output.result(
          await (
            await getService()
          ).buyCredits({
            packId,
            method: options.method,
            maxPriceCents: options.maxPriceCents,
            ...(options.operationId
              ? { operationId: options.operationId }
              : {}),
            ...(options.returnPath ? { returnPath: options.returnPath } : {}),
            progress: runtime.output.progress,
          }),
        ),
    );

  const webhooks = program
    .command("webhooks")
    .description("Manage signed completion webhooks");
  webhooks
    .command("list")
    .action(async () =>
      runtime.output.result(await (await getService()).listWebhooks()),
    );
  webhooks
    .command("create")
    .requiredOption("--url <https-url>", "HTTPS delivery URL")
    .option(
      "--event <event>",
      "event name; repeat or comma-separate",
      collect,
      [],
    )
    .action(async (options: { url: string; event: string[] }) => {
      const url = new URL(options.url);
      if (url.protocol !== "https:") {
        throw new CliError("Webhook URLs must use HTTPS", {
          code: "invalid_webhook_url",
        });
      }
      const events = splitEvents(options.event);
      if (events.length === 0) {
        throw new CliError("At least one --event is required", {
          code: "invalid_argument",
        });
      }
      runtime.output.result(
        await (await getService()).createWebhook(url.toString(), events),
      );
    });
  webhooks
    .command("delete")
    .argument("<id>", "webhook ID")
    .action(async (id: string) =>
      runtime.output.result(await (await getService()).deleteWebhook(id)),
    );
  webhooks
    .command("test")
    .argument("<id>", "webhook ID")
    .action(async (id: string) =>
      runtime.output.result(await (await getService()).testWebhook(id)),
    );

  program
    .command("mcp")
    .description("Run the local Segly MCP server over stdio")
    .action(async () => {
      const { startMcpServer } = await import("./mcp.js");
      await startMcpServer(await getService());
    });

  program.exitOverride();
  return program;
}

export async function runCli(
  argv: string[] = process.argv,
  runtimeOverrides: Partial<Runtime> = {},
): Promise<number> {
  const output = runtimeOverrides.output ?? createOutputWriter();
  try {
    await createCli({ ...runtimeOverrides, output }).parseAsync(argv);
    return 0;
  } catch (error) {
    if (
      error instanceof CommanderError &&
      ["commander.helpDisplayed", "commander.version"].includes(error.code)
    ) {
      return 0;
    }
    const normalized =
      error instanceof CommanderError
        ? new CliError(error.message, {
            code: "invalid_arguments",
            exitCode: 1,
          })
        : error;
    return output.failure(normalized);
  }
}
