import {
  AUTH_FAILURE_CODES,
  type AckKeyResponse,
  type AckResponse,
  type ApiErrorBody,
  type ApiErrorCode,
  type AssignableDeviceRole,
  type CreateGroupRequest,
  type CreateGroupResponse,
  type DevicesListResponse,
  type PairingCompleteBody,
  type PairingPollResponse,
  type PairingRequestBody,
  type PendingMessagesResponse,
  type PublishSigningKeyRequest,
  type PublishSigningKeyResponse,
  type RotateKeyRequest,
  type RotateKeyResponse,
  type SendMessageRequest,
  type UpdateSpaceNameRequest,
  type UpdateSpaceNameResponse,
} from "@sendself/shared";

const BASE = "/api";

/** Auth material attached to authenticated requests. */
export interface Auth {
  token: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/**
 * True when the server rejected our credentials for good: a token that no
 * device owns any more, or a device that was revoked. Retrying can only fail
 * the same way — the device has to be linked again.
 */
export function isAuthFailure(error: unknown): boolean {
  return error instanceof ApiError && AUTH_FAILURE_CODES.includes(error.code as ApiErrorCode);
}

type AuthFailureHandler = (error: ApiError) => void;

let authFailureHandler: AuthFailureHandler | null = null;

/**
 * Register what to do when an authenticated request is rejected for good.
 *
 * The API layer is the only place that sees every authenticated call, so the
 * dead-session check lives here instead of being repeated at each call site.
 * It stays a callback because this module also runs inside the service worker,
 * which has no UI to send the user back to.
 */
export function setAuthFailureHandler(handler: AuthFailureHandler | null): void {
  authFailureHandler = handler;
}

interface RequestOptions {
  auth?: Auth;
  jsonBody?: unknown;
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  retries?: number;
  signal?: AbortSignal;
}

async function rawRequest(method: string, path: string, opts: RequestOptions): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (opts.auth) {
    headers.set("Authorization", `Bearer ${opts.auth.token}`);
  }

  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
  } else if (opts.jsonBody !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(opts.jsonBody);
  }

  const maxAttempts = (opts.retries ?? 2) + 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body,
        signal: opts.signal,
      });
      // Retry transient server errors with backoff.
      if (response.status >= 500 && attempt < maxAttempts - 1) {
        await delay(250 * 2 ** attempt, opts.signal);
        continue;
      }
      if (!response.ok) {
        const error = await toApiError(response);
        // Only requests that presented credentials say anything about them:
        // an unauthenticated endpoint answering 401 is not a dead session.
        if (opts.auth && isAuthFailure(error)) authFailureHandler?.(error);
        throw error;
      }
      return response;
    } catch (err) {
      // A lifecycle handoff deliberately aborts the page request so the
      // service worker can take over. Do not hide that behind retries/backoff.
      if (opts.signal?.aborted) throw err;
      if (err instanceof ApiError) throw err;
      // Network failure: back off and retry.
      lastError = err;
      if (attempt < maxAttempts - 1) {
        await delay(250 * 2 ** attempt, opts.signal);
      }
    }
  }
  throw new NetworkError(lastError instanceof Error ? lastError.message : "Network request failed");
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = "internal";
  let message = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (body?.error) {
      code = body.error.code;
      message = body.error.message;
    }
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(response.status, code, message);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function jsonRequest<T>(method: string, path: string, opts: RequestOptions): Promise<T> {
  const response = await rawRequest(method, path, opts);
  return (await response.json()) as T;
}

// --- API surface ---------------------------------------------------------

export const api = {
  createGroup(body: CreateGroupRequest): Promise<CreateGroupResponse> {
    return jsonRequest("POST", "/groups", { jsonBody: body });
  },

  pairingRequest(pairingId: string, body: PairingRequestBody): Promise<void> {
    return jsonRequest("POST", `/pairing/${pairingId}/request`, { jsonBody: body });
  },

  pairingComplete(pairingId: string, body: PairingCompleteBody, auth: Auth): Promise<void> {
    return jsonRequest("POST", `/pairing/${pairingId}/complete`, { jsonBody: body, auth });
  },

  pairingPoll(pairingId: string): Promise<PairingPollResponse> {
    return jsonRequest("GET", `/pairing/${pairingId}`, { retries: 0 });
  },

  async pairingDelete(pairingId: string): Promise<void> {
    await rawRequest("DELETE", `/pairing/${pairingId}`, { retries: 0 });
  },

  sendMessage(body: SendMessageRequest, auth: Auth, signal?: AbortSignal): Promise<void> {
    return jsonRequest("POST", "/messages", { jsonBody: body, auth, signal });
  },

  pendingMessages(auth: Auth, since = 0): Promise<PendingMessagesResponse> {
    return jsonRequest("GET", `/messages/pending?since=${since}`, { auth, retries: 0 });
  },

  ackMessage(id: string, auth: Auth): Promise<AckResponse> {
    return jsonRequest("POST", `/messages/${id}/ack`, { auth });
  },

  async uploadFile(
    r2Key: string,
    ciphertext: ArrayBuffer,
    auth: Auth,
    signal?: AbortSignal,
  ): Promise<void> {
    await rawRequest("PUT", `/files/${r2Key}`, { rawBody: ciphertext, auth, signal });
  },

  async downloadFile(r2Key: string, auth: Auth): Promise<ArrayBuffer> {
    const response = await rawRequest("GET", `/files/${r2Key}`, { auth, retries: 1 });
    return response.arrayBuffer();
  },

  rotateKey(body: RotateKeyRequest, auth: Auth): Promise<RotateKeyResponse> {
    return jsonRequest("POST", "/keys/rotate", { jsonBody: body, auth });
  },

  ackKey(epoch: number, auth: Auth): Promise<AckKeyResponse> {
    return jsonRequest("POST", `/keys/${epoch}/ack`, { auth });
  },

  updateSpaceName(body: UpdateSpaceNameRequest, auth: Auth): Promise<UpdateSpaceNameResponse> {
    return jsonRequest("PUT", "/groups/self/name", { jsonBody: body, auth });
  },

  listDevices(auth: Auth): Promise<DevicesListResponse> {
    return jsonRequest("GET", "/devices", { auth, retries: 1 });
  },

  publishSigningKey(
    body: PublishSigningKeyRequest,
    auth: Auth,
  ): Promise<PublishSigningKeyResponse> {
    return jsonRequest("POST", "/devices/self/signing-key", { jsonBody: body, auth });
  },

  revokeDevice(id: string, auth: Auth): Promise<void> {
    return jsonRequest("DELETE", `/devices/${id}`, { auth });
  },

  updateDeviceRole(id: string, role: AssignableDeviceRole, auth: Auth): Promise<void> {
    return jsonRequest("PATCH", `/devices/${id}/role`, { jsonBody: { role }, auth });
  },
};
