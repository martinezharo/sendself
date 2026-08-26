import type { ApiErrorBody, ApiErrorCode } from "@sendself/shared";

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  device_revoked: 403,
  not_found: 404,
  conflict: 409,
  key_rotated: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal: 500,
};

/** A typed error that maps cleanly to an HTTP JSON response. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }

  get status(): number {
    return STATUS[this.code];
  }

  toResponse(): Response {
    const body: ApiErrorBody = { error: { code: this.code, message: this.message } };
    return Response.json(body, { status: this.status });
  }
}

/** JSON success helper. */
export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}
