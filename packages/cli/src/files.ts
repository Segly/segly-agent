import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CliError } from "./errors.js";
import type { PreparedImage } from "./types.js";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function detectImageContentType(
  bytes: Buffer,
): PreparedImage["contentType"] | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function prepareImage(path: string): Promise<PreparedImage> {
  const metadata = await stat(path).catch((error: unknown) => {
    throw new CliError("Input image could not be read", {
      code: "input_unreadable",
      cause: error,
    });
  });
  if (!metadata.isFile()) {
    throw new CliError("Input image must be a file", { code: "invalid_input" });
  }
  if (metadata.size > MAX_UPLOAD_BYTES) {
    throw new CliError("Input image exceeds the 10 MB limit", {
      code: "upload_too_large",
      details: { max_bytes: MAX_UPLOAD_BYTES },
    });
  }
  const bytes = await readFile(path);
  const contentType = detectImageContentType(bytes);
  if (!contentType) {
    throw new CliError("Input must contain a PNG, JPEG, or WebP image", {
      code: "unsupported_image",
    });
  }
  return {
    bytes,
    contentType,
    filename: basename(path),
    sha256: sha256(bytes),
  };
}

export interface DownloadResult {
  bytes: number;
  sha256: string;
  output_path: string;
}

function normalizedChecksum(checksum: string): string {
  return checksum.toLowerCase().replace(/^sha256:/u, "");
}

export async function atomicDownload(
  response: Response,
  outputPath: string,
  expectedSha256?: string,
  overwrite = false,
  expectedBytes?: number,
): Promise<DownloadResult> {
  if (!response.body) {
    throw new CliError("Artifact response did not contain a body", {
      code: "empty_download",
    });
  }
  if (!overwrite) {
    try {
      await access(outputPath);
      throw new CliError("Output already exists; pass --force to replace it", {
        code: "output_exists",
      });
    } catch (error) {
      if (error instanceof CliError) throw error;
    }
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${randomUUID()}.tmp`,
  );
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(
        response.body as import("node:stream/web").ReadableStream,
      ),
      meter,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    const digest = hash.digest("hex");
    if (expectedSha256 && digest !== normalizedChecksum(expectedSha256)) {
      throw new CliError("Artifact checksum did not match the API response", {
        code: "checksum_mismatch",
        details: {
          expected_sha256: normalizedChecksum(expectedSha256),
          actual_sha256: digest,
        },
      });
    }
    if (expectedBytes !== undefined && bytes !== expectedBytes) {
      throw new CliError("Artifact byte size did not match the API response", {
        code: "size_mismatch",
        details: {
          expected_bytes: expectedBytes,
          actual_bytes: bytes,
        },
      });
    }
    await rename(temporary, outputPath);
    return { bytes, sha256: digest, output_path: outputPath };
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export function artifactFilename(
  jobId: string,
  kind: string,
  contentType?: string,
): string {
  const extensions: Record<string, string> = {
    "application/zip": ".zip",
    "image/png": ".png",
    "image/vnd.adobe.photoshop": ".psd",
  };
  const existing = extname(kind)
    ? ""
    : ((contentType ? extensions[contentType] : undefined) ?? "");
  const safeKind = kind.replace(/[^A-Za-z0-9._-]/gu, "-");
  const safeJob = jobId.replace(/[^A-Za-z0-9_-]/gu, "-");
  return `${safeJob}-${safeKind}${existing}`;
}
