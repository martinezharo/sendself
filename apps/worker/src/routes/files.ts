import { MAX_UPLOAD_SIZE } from "@sendself/shared";
import { authenticate } from "../auth";
import { fileStorageKey } from "../db";
import { ApiError } from "../errors";
import { requireId } from "../http";
import type { RouteContext } from "../router";
import { rateLimit } from "../security";

/**
 * Enforce the upload cap while R2 consumes the request stream.
 *
 * Content-Length is still checked when present, but it is client-controlled
 * and absent for chunked requests. Failing the stream at the first byte over
 * the limit prevents an oversized body from being fully written to R2 before
 * the size check runs.
 */
export function boundedUploadBody(body: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  exceeded: () => boolean;
} {
  let exceeded = false;
  let size = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > MAX_UPLOAD_SIZE) {
        exceeded = true;
        controller.error(new Error("upload_too_large"));
        return;
      }
      controller.enqueue(chunk);
    },
  });

  return { stream: body.pipeThrough(limiter), exceeded: () => exceeded };
}

async function discardUpload(env: RouteContext["env"], storageKey: string): Promise<void> {
  try {
    await env.FILES.delete(storageKey);
  } catch {
    // Preserve the original upload/body error; cleanup can be retried by TTL.
  }
}

/**
 * Stream an already-encrypted file blob into R2. The body is opaque ciphertext;
 * the server never holds the key. The storage key is namespaced by the caller's
 * group so a device can never write into another group's namespace.
 */
export async function uploadFile(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  await rateLimit(c.env, "RL_UPLOAD", auth.deviceId);
  const key = requireId(c.params.r2key, "r2key");

  // R2 requires a known stream length. The client always sends a fully
  // encrypted ArrayBuffer, so keep requiring Content-Length and use the
  // bounded transform below as defense in depth against a lying value.
  const lengthHeader = c.request.headers.get("Content-Length");
  if (!lengthHeader) {
    throw new ApiError("bad_request", "Missing Content-Length");
  }
  const length = Number(lengthHeader);
  if (!Number.isFinite(length) || length <= 0) {
    throw new ApiError("bad_request", "Invalid Content-Length");
  }
  if (length > MAX_UPLOAD_SIZE) {
    throw new ApiError("payload_too_large", "File exceeds the 50 MB limit");
  }
  if (!c.request.body) {
    throw new ApiError("bad_request", "Empty request body");
  }

  const storageKey = fileStorageKey(auth.groupId, key);
  const bounded = boundedUploadBody(c.request.body);
  const fixed = new FixedLengthStream(length);
  const copy = bounded.stream.pipeTo(fixed.writable).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const put = c.env.FILES.put(storageKey, fixed.readable, {
    httpMetadata: { contentType: "application/octet-stream" },
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const [copyResult, putResult] = await Promise.all([copy, put]);

  if (!copyResult.ok) {
    await discardUpload(c.env, storageKey);
    if (bounded.exceeded()) {
      throw new ApiError("payload_too_large", "File exceeds the 50 MB limit");
    }
    throw new ApiError("bad_request", "Request body does not match Content-Length");
  }
  if (!putResult.ok) {
    await discardUpload(c.env, storageKey);
    throw putResult.error;
  }
  const object = putResult.value;

  // Defense-in-depth: enforce the cap on the real stored size too, in case a
  // storage implementation reports a size different from the stream counter.
  if (object.size > MAX_UPLOAD_SIZE) {
    await c.env.FILES.delete(storageKey);
    throw new ApiError("payload_too_large", "File exceeds the 50 MB limit");
  }

  return Response.json({ ok: true });
}

/** Stream an encrypted file blob back to an authenticated device. */
export async function downloadFile(c: RouteContext): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  const key = requireId(c.params.r2key, "r2key");

  const object = await c.env.FILES.get(fileStorageKey(auth.groupId, key));
  if (!object) {
    throw new ApiError("not_found", "File not found or already deleted");
  }

  const headers = new Headers();
  headers.set("Content-Type", "application/octet-stream");
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "no-store");
  object.writeHttpMetadata(headers);

  return new Response(object.body, { headers });
}
