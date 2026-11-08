import { SELF, createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { promoEvent } from "./promo";

const URL_ = "https://x.dev/api/promo-event";

const VALID = {
  event: "create-space",
  promo: "sendself",
  source: "rankmaker",
  placement: "end-card",
  locale: "es",
  variant: "short-1",
};

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/promo-event", () => {
  it("counts a valid event", async () => {
    const response = await post(VALID, { Origin: "https://x.dev" });
    expect(response.status).toBe(204);
  });

  it("accepts an empty variant", async () => {
    expect((await post({ ...VALID, variant: "" })).status).toBe(204);
  });

  it("writes the shared schema to the dataset", async () => {
    const writeDataPoint = vi.fn();
    const request = new Request(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });
    const response = await promoEvent({
      request,
      env: { ...env, PROMO_ANALYTICS: { writeDataPoint } },
      ctx: createExecutionContext(),
      params: {},
      url: new URL(URL_),
    });

    expect(response.status).toBe(204);
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ["create-space", "rankmaker", "sendself", "end-card", "es", "short-1"],
      doubles: [1],
      indexes: ["sendself"],
    });
  });

  it("rejects events that break the contract", async () => {
    for (const body of [
      { ...VALID, event: "click" },
      { ...VALID, promo: "rankmaker" },
      { ...VALID, source: "elsewhere" },
      { ...VALID, placement: "" },
      { ...VALID, placement: "End-Card" },
      { ...VALID, placement: "a".repeat(33) },
      { ...VALID, locale: "esp" },
      { ...VALID, variant: "-x" },
      { ...VALID, variant: 1 },
      [VALID],
      "not json",
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("rejects a body over 256 bytes", async () => {
    const response = await post({ ...VALID, padding: "x".repeat(256) });
    expect(response.status).toBe(413);
  });

  it("rejects another origin and a non-JSON content type", async () => {
    expect((await post(VALID, { Origin: "https://evil.dev" })).status).toBe(403);
    expect((await post(VALID, { "Content-Type": "text/plain" })).status).toBe(400);
  });

  it("only answers POST", async () => {
    const response = await SELF.fetch(URL_);
    expect(response.status).toBe(404);
  });

  it("answers a rejected event with the API's JSON error body", async () => {
    const response = await post({ ...VALID, event: "nope" });
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("bad_request");
  });
});
