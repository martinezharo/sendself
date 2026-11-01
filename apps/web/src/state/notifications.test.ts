import { beforeEach, describe, expect, it, vi } from "vitest";

const pushUnsubscribe = vi.fn();
const metaGet = vi.fn();

vi.mock("../api/client", async () => {
  const { ApiError, NetworkError, isAuthFailure } = await import("@sendself/client/api");
  return {
    ApiError,
    NetworkError,
    isAuthFailure,
    api: {},
    quietApi: { pushUnsubscribe },
  };
});
vi.mock("../db/spaces", () => ({
  GLOBAL_PUSH_ENABLED: "pushEnabled",
  globalMetaGet: metaGet,
  globalMetaSet: vi.fn(),
}));

const { ApiError, NetworkError } = await import("@sendself/client/api");
const { session } = await import("./session");
const { forgetPushForSpace } = await import("./notifications");

beforeEach(() => {
  pushUnsubscribe.mockReset();
  metaGet.mockReset();
  session.value = { deviceAuthToken: "token", groupId: "group" } as never;
});

describe("forgetPushForSpace", () => {
  it("lets the device leave once the server dropped the registration", async () => {
    pushUnsubscribe.mockResolvedValue({});
    expect(await forgetPushForSpace()).toBe(true);
  });

  it("lets a revoked device leave: its subscription is already gone", async () => {
    pushUnsubscribe.mockRejectedValue(new ApiError(401, "unauthorized", "revoked"));
    metaGet.mockResolvedValue(true);
    expect(await forgetPushForSpace()).toBe(true);
  });

  it("refuses to leave while notifications are on and the server is unreachable", async () => {
    pushUnsubscribe.mockRejectedValue(new NetworkError("offline"));
    metaGet.mockResolvedValue(true);
    expect(await forgetPushForSpace()).toBe(false);
  });

  it("leaves freely when notifications are off", async () => {
    pushUnsubscribe.mockRejectedValue(new NetworkError("offline"));
    metaGet.mockResolvedValue(false);
    expect(await forgetPushForSpace()).toBe(true);
  });
});
