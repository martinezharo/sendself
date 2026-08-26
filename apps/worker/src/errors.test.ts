import type { ApiErrorBody, ApiErrorCode } from "@sendself/shared";
import { describe, expect, it } from "vitest";
import { ApiError, json } from "./errors";

describe("ApiError", () => {
  it.each<[ApiErrorCode, number]>([
    ["bad_request", 400],
    ["unauthorized", 401],
    ["forbidden", 403],
    ["device_revoked", 403],
    ["not_found", 404],
    ["conflict", 409],
    ["key_rotated", 409],
    ["payload_too_large", 413],
    ["rate_limited", 429],
    ["internal", 500],
  ])("maps %s to HTTP %i", (code, status) => {
    expect(new ApiError(code, "message").status).toBe(status);
  });

  it("serialises to the shared ApiErrorBody shape", async () => {
    const response = new ApiError("conflict", "Message id already exists").toResponse();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "conflict", message: "Message id already exists" },
    } satisfies ApiErrorBody);
  });

  it("is an Error, so it survives a rethrow through generic catch blocks", () => {
    const error = new ApiError("not_found", "gone");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiError");
    expect(error.message).toBe("gone");
  });
});

describe("json", () => {
  it("writes a JSON body with the given init", async () => {
    const response = json({ ok: true }, { status: 201 });

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(await response.json()).toEqual({ ok: true });
  });
});
