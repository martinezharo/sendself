/**
 * Play Store artwork: the feature graphic and phone screenshots.
 *
 * Runs the built PWA against a local Worker (temporary D1/R2 state), drives the
 * first-run flow in a real browser, and writes the PNGs Google Play expects.
 * The AAB itself points at production; these are only store assets.
 *
 *   pnpm --filter @sendself/web build
 *   pnpm android:play-assets
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const webDist = resolve(root, "apps/web/dist");
const playDir = resolve(root, "apps/android/play");
const screenshotsDir = resolve(playDir, "screenshots");
const requireFromWeb = createRequire(resolve(root, "apps/web/package.json"));
const port = 8790;
const baseUrl = `http://localhost:${port}`;

if (!existsSync(resolve(webDist, "app.html"))) {
  console.log("Building the PWA first…");
  const build = spawnSync("pnpm", ["--filter", "@sendself/web", "build"], {
    cwd: root,
    stdio: "inherit",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const stateDir = await mkdtemp(join(tmpdir(), "sendself-play-assets-"));

const migrate = spawnSync(
  "pnpm",
  [
    "--filter",
    "@sendself/worker",
    "exec",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "sendself-db",
    "--local",
    "--persist-to",
    stateDir,
  ],
  { cwd: root, stdio: "inherit" },
);
if (migrate.status !== 0) {
  await rm(stateDir, { recursive: true, force: true });
  process.exit(migrate.status ?? 1);
}

const worker = spawn(
  "pnpm",
  [
    "--filter",
    "@sendself/worker",
    "exec",
    "wrangler",
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    stateDir,
  ],
  {
    cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  },
);
let workerLog = "";
worker.stdout.on("data", (chunk) => (workerLog += chunk));
worker.stderr.on("data", (chunk) => (workerLog += chunk));

function stopWorker(signal = "SIGTERM") {
  try {
    process.kill(-worker.pid, signal);
  } catch {
    worker.kill(signal);
  }
}

process.on("SIGINT", () => {
  stopWorker();
  process.exit(130);
});

/** Wait for wrangler dev to answer, or fail with its log. */
async function waitForServer() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`wrangler dev exited early:\n${workerLog}`);
    try {
      const response = await fetch(`${baseUrl}/app`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`wrangler dev did not start:\n${workerLog}`);
}

async function settle(page) {
  await page
    .getByText("Create a new space")
    .or(page.getByRole("heading", { name: "Your spaces" }))
    .or(page.getByPlaceholder("Write a message"))
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(600);
}

/** Freeze motion so a screenshot never catches a fade or a blinking caret. */
const CALM_CSS =
  "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}";

async function shot(page, name) {
  await page.addStyleTag({ content: CALM_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(screenshotsDir, name) });
  console.log(`  ${name}`);
}

/** Feature graphic: 1024×500, no transparency, brand fonts embedded. */
async function featureGraphic(browser) {
  const [bricolage, hanken, logo] = await Promise.all([
    readFile(
      requireFromWeb.resolve(
        "@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2",
      ),
    ),
    readFile(
      requireFromWeb.resolve(
        "@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2",
      ),
    ),
    readFile(resolve(root, "apps/web/public/sendself-logo.svg"), "utf8"),
  ]);

  const mark = logo
    .replace(/<\?xml[^>]*\?>\s*/, "")
    .replace(/fill="#000"/g, 'fill="#fff"')
    .replace(/stroke="#000"/g, 'stroke="#fff"')
    .replace(/width="1095" height="1095"/, 'width="240" height="240"');

  const page = await browser.newPage({ viewport: { width: 1024, height: 500 } });
  await page.setContent(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  @font-face {
    font-family: "Bricolage";
    src: url(data:font/woff2;base64,${bricolage.toString("base64")}) format("woff2");
    font-weight: 200 800;
    font-display: block;
  }
  @font-face {
    font-family: "Hanken";
    src: url(data:font/woff2;base64,${hanken.toString("base64")}) format("woff2");
    font-weight: 100 900;
    font-display: block;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1024px; height: 500px; overflow: hidden; }
  body {
    font-family: "Hanken", sans-serif;
    color: #fff;
    background:
      radial-gradient(900px 520px at 92% -18%, rgba(255, 196, 150, .38), transparent 64%),
      radial-gradient(700px 460px at -12% 118%, rgba(92, 30, 8, .45), transparent 66%),
      linear-gradient(128deg, #f97316 0%, #c2410c 44%, #7c2d12 100%);
  }
  .canvas {
    position: relative;
    display: flex;
    align-items: center;
    gap: 54px;
    width: 100%;
    height: 100%;
    padding: 54px 62px;
  }
  .mark-card {
    display: grid;
    place-items: center;
    flex: none;
    width: 318px;
    height: 318px;
    border-radius: 68px;
    background: rgba(255, 255, 255, .13);
    border: 1px solid rgba(255, 255, 255, .25);
    box-shadow: 0 34px 70px rgba(65, 18, 3, .28), inset 0 1px 0 rgba(255, 255, 255, .22);
    backdrop-filter: blur(2px);
  }
  .mark-card svg { width: 238px; height: 238px; filter: drop-shadow(0 12px 20px rgba(60, 16, 3, .18)); }
  .copy { display: flex; flex-direction: column; min-width: 0; }
  .kicker {
    margin: 0 0 12px;
    font: 700 17px/1 "Hanken", sans-serif;
    letter-spacing: .19em;
    text-transform: uppercase;
    color: rgba(255, 244, 238, .82);
  }
  h1 {
    margin: 0;
    font-family: "Bricolage", sans-serif;
    font-weight: 700;
    font-size: 104px;
    line-height: .9;
    letter-spacing: -.055em;
  }
  .tagline {
    margin: 18px 0 0;
    max-width: 560px;
    font-size: 27px;
    line-height: 1.32;
    font-weight: 480;
    color: rgba(255, 247, 243, .93);
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    align-self: flex-start;
    margin-top: 24px;
    padding: 10px 16px 11px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, .28);
    background: rgba(61, 17, 5, .18);
    font-size: 17px;
    font-weight: 650;
    letter-spacing: .01em;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #fde68a; box-shadow: 0 0 0 4px rgba(253, 230, 138, .18); }
</style>
</head>
<body>
  <div class="canvas">
    <div class="mark-card">${mark}</div>
    <div class="copy">
      <p class="kicker">Private file &amp; text sharing</p>
      <h1>SendSelf</h1>
      <p class="tagline">End-to-end encrypted between your own devices.<br />No account. No plaintext on the server.</p>
      <div class="pill"><span class="dot"></span>Free · Works offline</div>
    </div>
  </div>
</body>
</html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(playDir, "feature-graphic.png") });
  await page.close();
  console.log("  feature-graphic.png (1024×500)");
}

try {
  await waitForServer();

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 540, height: 960 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: "en-US",
    colorScheme: "light",
  });
  const page = await context.newPage();

  page.on("console", (message) => {
    if (message.type() === "error") console.error("  page error:", message.text());
  });

  await page.goto(`${baseUrl}/app`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await shot(page, "01-first-run.png");

  await page.getByText("Create a new space").first().click();
  await page.getByPlaceholder("e.g. Personal").fill("Home");
  await page.getByPlaceholder("e.g. My laptop").fill("Pixel");
  await shot(page, "02-create-space.png");

  await page.getByRole("button", { name: "Create space" }).click();
  await page.waitForURL(/\/app\/[^/]+/);
  await settle(page);
  const spacePath = new URL(page.url()).pathname;

  const composer = page.getByPlaceholder("Write a message");
  async function send(text) {
    await composer.fill(text);
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByText(text).waitFor();
  }

  await send("Launch notes are ready.");
  await send("Everything here is encrypted before it leaves this phone.");
  await send("The full checklist is attached.");

  await page.locator('input[type="file"]').setInputFiles({
    name: "launch-notes.png",
    mimeType: "image/png",
    buffer: await readFile(resolve(playDir, "icon-512.png")),
  });
  await page.getByText("launch-notes.png").waitFor();
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForTimeout(3_000);
  await shot(page, "03-chat.png");

  await page.getByRole("link", { name: "All spaces" }).click();
  await page.getByRole("heading", { name: "Your spaces" }).waitFor();
  await shot(page, "04-spaces.png");

  await page.goto(`${baseUrl}${spacePath}/devices`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Linked devices" }).waitFor();
  await page.waitForTimeout(600);
  await shot(page, "05-devices.png");

  await featureGraphic(browser);

  await page.goto("about:blank");
  await context.close();
  await browser.close();

  console.log(`\nPlay assets written to ${playDir}`);
} finally {
  stopWorker();
  await new Promise((resolve) => setTimeout(resolve, 500));
  stopWorker("SIGKILL");
  await rm(stateDir, { recursive: true, force: true });
}
