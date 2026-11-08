import { ApiError } from "./errors";

/**
 * Upper bound for any JSON request body. Generous enough for the largest
 * legitimate payload (a text message's `encryptedPayload`, capped at 1 MB by
 * `requireString`) plus JSON overhead, while still rejecting a client that
 * tries to make us buffer/parse an oversized body before per-field checks run.
 */
const MAX_JSON_BODY_SIZE = 2 * 1024 * 1024;

/**
 * Read at most `maxBytes` (by default the JSON body limit) before parsing it.
 *
 * Checking Content-Length is useful as a cheap early rejection, but it is an
 * untrusted header and chunked requests do not have one. Reading through the
 * stream keeps the limit effective for both forms instead of letting
 * `Request.json()` buffer an arbitrarily large body first.
 */
export async function readJson<T>(request: Request, maxBytes = MAX_JSON_BODY_SIZE): Promise<T> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isFinite(length) || length < 0) {
      throw new ApiError("bad_request", "Invalid Content-Length");
    }
    if (length > maxBytes) {
      throw new ApiError("payload_too_large", "Request body too large");
    }
  }

  try {
    const body = request.body;
    if (!body) throw new Error("empty body");

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // The body is already unusable; the size error is the useful one.
          }
          throw new ApiError("payload_too_large", "Request body too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("bad_request", "Invalid JSON body");
  }
}

/** Parse a JSON object body, rejecting null, arrays and primitive JSON values. */
export async function readJsonObject<T>(
  request: Request,
  maxBytes = MAX_JSON_BODY_SIZE,
): Promise<T> {
  const body = await readJson<unknown>(request, maxBytes);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("bad_request", "JSON body must be an object");
  }
  return body as T;
}

/** Assert a value is a non-empty string within an optional length bound. */
export function requireString(value: unknown, field: string, maxLen = 4096): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError("bad_request", `Missing or invalid field: ${field}`);
  }
  if (value.length > maxLen) {
    throw new ApiError("bad_request", `Field too long: ${field}`);
  }
  return value;
}

/** Optional string field: returns undefined when absent/null, validates otherwise. */
export function optionalString(value: unknown, field: string, maxLen = 4096): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field, maxLen);
}

/** Validate a client-provided SHA-256 digest: exactly 64 lowercase hex chars. */
export function requireSha256Hex(value: unknown, field: string): string {
  const s = requireString(value, field, 64);
  if (!/^[0-9a-f]{64}$/.test(s)) {
    throw new ApiError("bad_request", `Invalid SHA-256 hex digest in field: ${field}`);
  }
  return s;
}

/** Validate a client-provided integer within an inclusive range. */
export function requireInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError("bad_request", `Missing or invalid integer field: ${field}`);
  }
  return value;
}

/**
 * Validate a client-provided opaque id (R2 keys, ids). Restricts to URL-safe
 * characters so it is always safe as a single path segment / object key.
 */
export function requireId(value: unknown, field: string): string {
  const s = requireString(value, field, 256);
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new ApiError("bad_request", `Invalid characters in field: ${field}`);
  }
  return s;
}
