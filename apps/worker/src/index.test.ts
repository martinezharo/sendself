import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { fileStorageKey } from "./db";
import worker from "./index";
import { errorCode, seedMessage, seedSpace } from "./test/helpers";

describe("fetch dispatch", () => {
  it("answers an unknown /api path with a JSON not_found", async () => {
    const response = await SELF.fetch("https://x.dev/api/nope");

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });

  it("answers a known path with the wrong method as not_found", async () => {
    const response = await SELF.fetch("https://x.dev/api/groups", { method: "GET" });

    expect(response.status).toBe(404);
  });

  it("redirects HTTP requests to HTTPS before dispatching them", async () => {
    const response = await SELF.fetch("http://x.dev/private?from=seo", { redirect: "manual" });

    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("https://x.dev/private?from=seo");
  });

  it("redirects the www hostname to the canonical origin", async () => {
    const response = await SELF.fetch("https://www.sendself.4oli.com/security/", {
      redirect: "manual",
    });

    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("https://sendself.4oli.com/security/");
  });

  it("serves everything outside /api from the assets binding", async () => {
    const response = await SELF.fetch("https://x.dev/some/spa/route");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("static asset /some/spa/route");
  });

  it("serves every /app URL the app shell, never the marketing document", async () => {
    // `/app.html` is the shell's own name, which the service worker precaches.
    for (const path of ["/app", "/app/local-id", "/app/local-id/devices", "/app.html"]) {
      const response = await SELF.fetch(`https://x.dev${path}`);

      expect(await response.text()).toBe("static asset /app.html");
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
  });

  it("keeps the public page on the prerendered marketing document", async () => {
    const response = await SELF.fetch("https://sendself.4oli.com/");

    expect(await response.text()).toBe("static asset /");
  });

  it("applies the security headers to API responses, errors included", async () => {
    const response = await SELF.fetch("https://x.dev/api/nope");

    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("applies the security headers to static assets too", async () => {
    const response = await SELF.fetch("https://x.dev/index.html");

    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("turns an unexpected throw into a generic 500 that leaks nothing", async () => {
    // `authenticate` runs before any validation, so a broken DB binding is the
    // simplest way to reach the catch-all. What matters is the shape of the
    // answer: a typed JSON error, never a stack trace or a SQL message.
    const broken = {
      ...env,
      DB: {
        prepare() {
          throw new Error("d1: table devices has no column named secret_stuff");
        },
      },
    } as unknown as typeof env;
    const ctx = createExecutionContext();

    const response = await worker.fetch(
      new Request("https://x.dev/api/devices", { headers: { Authorization: "Bearer t" } }),
      broken,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      error: { code: "internal", message: "Internal server error" },
    });
    expect(body).not.toContain("secret_stuff");
  });
});

describe("scheduled", () => {
  it("runs the cleanup the cron trigger is there for", async () => {
    const { groupId, owner } = await seedSpace();
    const stale = await seedMessage(groupId, owner.id, {
      createdAt: Date.now() - 48 * 60 * 60 * 1000,
      fileR2Key: "stale",
    });
    await env.FILES.put(fileStorageKey(groupId, "stale"), "ciphertext");
    const ctx = createExecutionContext();

    await worker.scheduled({} as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);

    const row = await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(stale).first();
    expect(row).toBeNull();
    expect(await env.FILES.head(fileStorageKey(groupId, "stale"))).toBeNull();
  });
});
