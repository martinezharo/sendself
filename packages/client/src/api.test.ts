import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "./api";

const api = createApi({ baseUrl: "/api" });

describe("upload cancellation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not retry a request deliberately aborted for a worker handoff", async () => {
    const controller = new AbortController();
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const fetchMock = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestStarted();
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const upload = api.uploadFile(
      "file-1",
      new ArrayBuffer(16),
      { token: "token" },
      controller.signal,
    );
    await started;
    controller.abort();

    await expect(upload).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
