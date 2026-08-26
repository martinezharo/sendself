import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests: the real PWA, in a real browser, against a real Worker with
 * a real D1 and R2.
 *
 * What earns a test here is anything the unit tests structurally cannot see —
 * a device closing the app and coming back, storage that outlives the page,
 * the browser's own Back button. Everything else belongs in vitest, which is
 * three orders of magnitude faster.
 *
 * Ports and state are deliberately not the ones `pnpm dev` uses, so a run
 * neither waits for a free port nor writes over the database of a dev session
 * that happens to be open. `localhost` is not a preference either: Web Crypto
 * is unavailable outside a secure context, and that is what the app is built on.
 */

/**
 * One server, as in production: the Worker serves both the API and the built
 * PWA from a single origin. Not the dev server — Vite compiling on demand
 * turned page loads into the slowest thing in the suite, and what a user runs
 * is the bundle, service worker included.
 */
const PORT = 8788;

export default defineConfig({
  testDir: "./e2e",
  // Every test drives its own browser profile through several launches, so they
  // are slow by nature and independent by construction. Two at a time: they all
  // share one Worker, and past that it is the server, not the browser, that
  // becomes the slowest thing in the suite.
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  // See the note on webServer: a Worker that restarts under the suite can cost
  // one test the request it was making, and that is the whole of the flake.
  retries: 1,
  // Each test launches the app two or three times, and a launch absorbs a
  // Worker restart rather than failing on it.
  timeout: 150_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  /**
   * The Worker is kept alive by a loop inside `start:e2e`, not out of caution:
   * `wrangler dev` ends its entire session when a socket dies under it
   * ("Network connection lost" from its ProxyController), and a browser being
   * closed — which is what every test here does — is exactly that. It is the
   * dev server that is fragile, not the Worker: `wrangler deploy` runs the same
   * code without any of this. Restarting takes about a second, and `retries`
   * covers the test that was mid-request when it happened.
   */
  webServer: {
    command: "pnpm --filter @sendself/web build && pnpm --filter @sendself/worker run start:e2e",
    url: `http://localhost:${PORT}/app`,
    // Never reused: a server left over from a previous run would be serving the
    // previous build, and a suite that quietly tests yesterday's code is worse
    // than no suite. The rebuild costs about ten seconds.
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
