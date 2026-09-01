export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export interface ProblemDetails extends JsonObject {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  request_id?: string;
  retryable?: boolean;
}

export interface UploadResource extends JsonObject {
  id: string;
  status: string;
  content_type?: string;
  size_bytes?: number;
  sha256?: string;
  width?: number;
  height?: number;
  expires_at?: string;
}

export interface PreparedImage {
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  filename: string;
  sha256: string;
}

export interface LayerPrediction extends JsonObject {
  workflow: string;
  layers: string[];
  source: "model" | "fallback";
  credits: 0;
}

export interface SegmentationResource extends JsonObject {
  id: string;
  status: string;
  workflow?: string;
  layers?: JsonValue[];
  created_at?: string;
  retry_after_ms?: number;
}

export interface ArtifactResource extends JsonObject {
  kind: string;
  status: string;
  url?: string;
  content_type?: string;
  size_bytes?: number;
  sha256?: string;
  expires_at?: string;
  retry_after_ms?: number;
  message?: string;
}

export interface PageResource extends JsonObject {
  items: JsonValue[];
  next_cursor?: string | null;
}
