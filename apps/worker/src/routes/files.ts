import { MAX_UPLOAD_SIZE, SPACE_PENDING_BYTES_QUOTA } from "@sendself/shared";
import { authenticate } from "../auth";
import {
  type BlobStore,
  MESSAGE_FILES,
  blobStorageKey,
  deleteBlob,
  recordBlob,
  reserveBlob,
} from "../blobs";
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

async function discardUpload(
  env: RouteContext["env"],
  store: BlobStore,
  groupId: string,
  key: string,
): Promise<void> {
  try {
    await deleteBlob(env, store, groupId, key);
  } catch {
    // Preserve the original upload/body error; cleanup can be retried by TTL.
  }
}

/** What a store's quota is and what to tell a device that hit it. */
export interface BlobQuota {
  bytes: number;
  message: string;
}

/**
 * Stream an already-encrypted blob into `store`. The body is opaque
 * ciphertext; the server never holds the key. The storage key is namespaced by
 * the caller's group so a device can never write into another group's
 * namespace.
 */
export async function receiveBlob(
  c: RouteContext,
  store: BlobStore,
  quota: BlobQuota,
): Promise<Response> {
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

  // Counted before a byte reaches R2, so a space at its cap costs nothing more.
  // The declared length is what FixedLengthStream below holds the body to.
  const reserved = await reserveBlob(
    c.env,
    store,
    auth.groupId,
    key,
    length,
    quota.bytes,
    Date.now(),
  );
  if (!reserved) {
    throw new ApiError("quota_exceeded", quota.message);
  }

  const storageKey = blobStorageKey(auth.groupId, key);
  const bounded = boundedUploadBody(c.request.body);
  const fixed = new FixedLengthStream(length);
  const copy = bounded.stream.pipeTo(fixed.writable).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const put = store
    .bucket(c.env)
    .put(storageKey, fixed.readable, {
      httpMetadata: { contentType: "application/octet-stream" },
    })
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  const [copyResult, putResult] = await Promise.all([copy, put]);

  if (!copyResult.ok) {
    await discardUpload(c.env, store, auth.groupId, key);
    if (bounded.exceeded()) {
      throw new ApiError("payload_too_large", "File exceeds the 50 MB limit");
    }
    throw new ApiError("bad_request", "Request body does not match Content-Length");
  }
  if (!putResult.ok) {
    await discardUpload(c.env, store, auth.groupId, key);
    throw putResult.error;
  }
  const object = putResult.value;

  // Defense-in-depth: enforce the cap on the real stored size too, in case a
  // storage implementation reports a size different from the stream counter.
  if (object.size > MAX_UPLOAD_SIZE) {
    await deleteBlob(c.env, store, auth.groupId, key);
    throw new ApiError("payload_too_large", "File exceeds the 50 MB limit");
  }

  // A failed upload or a deletion of this same key may have dropped the row
  // while this write was in flight; the object exists now, so it is counted.
  await recordBlob(c.env, store, auth.groupId, key, object.size, Date.now());

  return Response.json({ ok: true });
}

/** Stream an encrypted blob from `store` back to an authenticated device. */
export async function sendBlob(c: RouteContext, store: BlobStore): Promise<Response> {
  const auth = await authenticate(c.request, c.env);
  const key = requireId(c.params.r2key, "r2key");

  const object = await store.bucket(c.env).get(blobStorageKey(auth.groupId, key));
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

const PENDING_QUOTA: BlobQuota = {
  bytes: SPACE_PENDING_BYTES_QUOTA,
  message:
    "This space is holding too many undelivered files; it will send once your devices catch up",
};

/** `PUT /api/files/:r2key`: a message attachment. */
export function uploadFile(c: RouteContext): Promise<Response> {
  return receiveBlob(c, MESSAGE_FILES, PENDING_QUOTA);
}

/** `GET /api/files/:r2key`. */
export function downloadFile(c: RouteContext): Promise<Response> {
  return sendBlob(c, MESSAGE_FILES);
}
