import { CREATE_SPACE_CHALLENGE_ACTION } from "@sendself/shared";
import { describe, expect, it, vi } from "vitest";
import { spaceChallengeSiteKey, verifySpaceChallenge } from "./challenge";
import type { Env } from "./env";
import { ApiError } from "./errors";

const configured = { TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" } as Env;

function siteverify(body: unknown, status = 200) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(body, { status }),
  );
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
  return "resolved";
}

describe("spaceChallengeSiteKey", () => {
  it("is null unless both halves of the widget are configured", () => {
    expect(spaceChallengeSiteKey({} as Env)).toBeNull();
    expect(spaceChallengeSiteKey({ TURNSTILE_SITE_KEY: "site" } as Env)).toBeNull();
    expect(spaceChallengeSiteKey({ TURNSTILE_SECRET_KEY: "secret" } as Env)).toBeNull();
    expect(spaceChallengeSiteKey(configured)).toBe("site");
  });
});

describe("verifySpaceChallenge", () => {
  it("asks nothing of the caller when no challenge is configured", async () => {
    const fetcher = siteverify({ success: false });

    await verifySpaceChallenge({} as Env, undefined, null, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a missing token without calling Siteverify", async () => {
    const fetcher = siteverify({ success: true, action: CREATE_SPACE_CHALLENGE_ACTION });

    expect(await codeOf(verifySpaceChallenge(configured, undefined, null, fetcher))).toBe(
      "challenge_failed",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts a token Siteverify vouches for, sending the secret and client IP", async () => {
    const fetcher = siteverify({ success: true, action: CREATE_SPACE_CHALLENGE_ACTION });

    await verifySpaceChallenge(configured, "token", "203.0.113.7", fetcher);

    const form = fetcher.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get("secret")).toBe("secret");
    expect(form.get("response")).toBe("token");
    expect(form.get("remoteip")).toBe("203.0.113.7");
  });

  it("refuses a token Siteverify rejects", async () => {
    const fetcher = siteverify({ success: false, "error-codes": ["invalid-input-response"] });

    expect(await codeOf(verifySpaceChallenge(configured, "token", null, fetcher))).toBe(
      "challenge_failed",
    );
  });

  it("refuses a valid token solved for another action", async () => {
    const fetcher = siteverify({ success: true, action: "something-else" });

    expect(await codeOf(verifySpaceChallenge(configured, "token", null, fetcher))).toBe(
      "challenge_failed",
    );
  });

  it("fails closed, as a transient error, when Siteverify is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const down = vi.fn(async () => {
      throw new TypeError("network down");
    });

    expect(await codeOf(verifySpaceChallenge(configured, "token", null, down))).toBe("internal");
    expect(
      await codeOf(verifySpaceChallenge(configured, "token", null, siteverify({}, 503))),
    ).toBe("internal");
  });
});
