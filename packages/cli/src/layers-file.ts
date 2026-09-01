import { readFile } from "node:fs/promises";
import { CliError } from "./errors.js";
import { validateLayers } from "./service.js";

const PREDICTION_KEYS = new Set(["workflow", "layers", "source", "credits"]);

export function parseLayersDocument(contents: string): string[] {
  const trimmed = contents.trim();
  if (!trimmed)
    throw new CliError("Layers file is empty", { code: "invalid_layers" });
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    return validateLayers(trimmed.split(/\r?\n/u));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new CliError("Layers JSON is invalid", {
      code: "invalid_layers",
      cause: error,
    });
  }
  if (Array.isArray(parsed)) {
    if (parsed.some((item) => typeof item !== "string")) {
      throw new CliError("Layers JSON must be an array of strings", {
        code: "invalid_layers",
      });
    }
    return validateLayers(parsed as string[]);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new CliError("Layers JSON must be an array or prediction response", {
      code: "invalid_layers",
    });
  }
  const prediction = parsed as Record<string, unknown>;
  if (Object.keys(prediction).some((key) => !PREDICTION_KEYS.has(key))) {
    throw new CliError(
      "Layers JSON contains fields unrelated to a prediction response",
      {
        code: "invalid_layers",
      },
    );
  }
  if (
    !Array.isArray(prediction.layers) ||
    prediction.layers.some((item) => typeof item !== "string") ||
    (prediction.workflow !== undefined &&
      typeof prediction.workflow !== "string") ||
    (prediction.source !== undefined &&
      !["model", "fallback"].includes(String(prediction.source))) ||
    (prediction.credits !== undefined && prediction.credits !== 0)
  ) {
    throw new CliError("Layers JSON is not a valid prediction response", {
      code: "invalid_layers",
    });
  }
  return validateLayers(prediction.layers as string[]);
}

export async function readLayersFile(path: string): Promise<string[]> {
  const contents = await readFile(path, "utf8").catch((error: unknown) => {
    throw new CliError("Layers file could not be read", {
      code: "layers_file_unreadable",
      cause: error,
    });
  });
  if (Buffer.byteLength(contents) > 64 * 1024) {
    throw new CliError("Layers file exceeds 64 KB", {
      code: "layers_file_too_large",
    });
  }
  return parseLayersDocument(contents);
}
