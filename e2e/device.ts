import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, type Page, chromium, test as base } from "@playwright/test";
import { PRE_REBRAND_ID } from "../apps/web/src/legacy";

/**
 * A device, as the app understands one.
 *
 * Everything that makes this app what it is lives outside the page: the
 * session, the keys, the history and the space registry are all in IndexedDB,
 * and the questions worth asking end to end are about what survives the app
 * being closed. So a device here is a browser profile on disk, and launching it
 * is a fresh browser session over that same profile — which is exactly what
 * reopening a PWA from the home screen does.
 *
 * A page is deliberately not handed out by the fixture: tests that never
 * relaunch would be unit tests, and the ones here always do.
 */
export class Device {
  private context: BrowserContext | null = null;

  constructor(
    private readonly profile: string,
    private readonly baseURL: string,
  ) {}

  /** Open the app the way the installed PWA does: at `/app`, naming no space. */
  async launch(path = "/app"): Promise<Page> {
    if (this.context) throw new Error("This device is already running; close it first");
    this.context = await chromium.launchPersistentContext(this.profile, {
      // Headed runs are for debugging a failure; the profile is what matters.
      headless: !process.env.PWDEBUG,
    });
    const page = this.context.pages()[0] ?? (await this.context.newPage());
    await stubRealtime(page);
    await this.load(page, path);
    return page;
  }

  /**
   * Load the app, allowing for a Worker that is briefly not there.
   *
   * `wrangler dev` restarts under this suite (see `stubRealtime`), and a page
   * that lands in that one-second window gets the prerendered shell with no
   * bundle behind it — a page that will never become the app, no matter how
   * long anything waits for it. Reloading is what a person would do, and it
   * keeps a dev-server hiccup from being reported as a broken app.
   */
  private async load(page: Page, path: string): Promise<void> {
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(`${this.baseURL}${path}`, { waitUntil: "domcontentloaded" });
        await settle(page, { landmark: attempt < 3 ? 15_000 : 30_000 });
        return;
      } catch (error) {
        last = error;
        await page.waitForTimeout(2_000);
      }
    }
    throw last;
  }

  /**
   * Close the app. Storage stays, as it would on a phone.
   *
   * Navigating away first is for the server's sake, not the app's: the sync
   * loop nearly always has a request in flight, and `wrangler dev` treats a
   * client that vanishes mid-request as fatal to its whole session (see
   * `stubRealtime`). Unloading the page ends those requests the way a browser
   * does before the process is gone.
   */
  async close(): Promise<void> {
    for (const page of this.context?.pages() ?? []) {
      await page.goto("about:blank").catch(() => {});
    }
    await this.context?.close();
    this.context = null;
  }

  /** Close and open again: the launch this whole suite is about. */
  async relaunch(path = "/app"): Promise<Page> {
    await this.close();
    return this.launch(path);
  }

  async dispose(): Promise<void> {
    await this.close();
    await rm(this.profile, { recursive: true, force: true });
  }
}

/**
 * Keep the realtime socket inside the browser.
 *
 * An open space holds a WebSocket to its Durable Object, and closing the
 * browser — which every test here does, repeatedly — cuts it without a
 * handshake. `wrangler dev` ends its entire session when that happens
 * ("Network connection lost" from its ProxyController), taking the rest of the
 * run with it. The deployed Worker is untouched by this; it is the dev server
 * that cannot take it.
 *
 * Closing the socket immediately is not a fiction the app has to be told about:
 * a realtime connection that will not open is a case it already handles, and it
 * falls back to the polling loop these tests read from anyway. What this does
 * cost is coverage of live push, which belongs in a test of its own rather than
 * underneath every test about where the app reopens.
 */
async function stubRealtime(page: Page): Promise<void> {
  await page.routeWebSocket(/\/api\/realtime/, (ws) => ws.close());
}

/**
 * Wait for the app to have finished deciding where it is.
 *
 * Two things have to be true, and neither implies the other: one of the app's
 * real screens is on show, and the URL has stopped moving. Booting reads
 * IndexedDB before it can know whether it is resuming into a space, so a
 * screen can render an instant before the route it belongs to is final —
 * asserting between those two moments is how this suite first "failed".
 */
export async function settle(
  page: Page,
  { landmark = 30_000, quietMs = 500 }: { landmark?: number; quietMs?: number } = {},
): Promise<void> {
  await page
    .getByText("Create a new space") // onboarding
    .or(page.getByRole("heading", { name: "Your spaces" })) // the space list
    .or(page.getByPlaceholder("Write a message")) // a space, on its chat
    .first()
    .waitFor({ state: "visible", timeout: landmark });

  let previous = "";
  let stableSince = Date.now();
  const deadline = Date.now() + 15_000;
  for (;;) {
    const current = new URL(page.url()).pathname;
    if (current !== previous) {
      previous = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return;
    }
    if (Date.now() > deadline) throw new Error(`The app never settled (last route: ${previous})`);
    await page.waitForTimeout(100);
  }
}

/** Where the app is, as the user would describe it. */
export function whereIs(page: Page): "landing" | "spaces" | string {
  const path = new URL(page.url()).pathname;
  if (path === "/") return "landing";
  if (path === "/app") return "spaces";
  return path.replace(/^\/app\//, "").split("/")[0] ?? "";
}

/** Create the first space on a device that has none, and land inside it. */
export async function createSpace(page: Page, name: string, deviceName: string): Promise<string> {
  await page.getByText("Create a new space").click();
  await page.getByPlaceholder("e.g. Personal").fill(name);
  await page.getByPlaceholder("e.g. My laptop").fill(deviceName);
  await page.getByRole("button", { name: "Create space" }).click();
  await page.waitForURL(/\/app\/[^/]+/);
  await settle(page);
  return whereIs(page);
}

/**
 * What being thrown out of a space looks like from this device: the credentials
 * it holds stop being accepted. Revoking from a second device would exercise
 * the same path from further away at several times the cost, so the token is
 * spoiled directly and the server is left to reject it for real.
 */
export async function revokeCredentials(page: Page, spaceId: string): Promise<void> {
  // The database name is resolved here, in Node: `evaluate` runs in the page,
  // where nothing this module imports exists.
  await page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite");
      const store = tx.objectStore("meta");
      const read = store.get("session");
      read.onsuccess = () => {
        const session = read.result;
        session.deviceAuthToken = "revoked-by-another-device";
        store.put(session, "session");
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }, `${PRE_REBRAND_ID}:${spaceId}`);
}

export const test = base.extend<{ device: Device }>({
  device: async ({ baseURL }, use) => {
    const profile = await mkdtemp(join(tmpdir(), "sendself-e2e-"));
    const device = new Device(profile, baseURL ?? "http://localhost:5174");
    await use(device);
    await device.dispose();
  },
});

export { expect } from "@playwright/test";
