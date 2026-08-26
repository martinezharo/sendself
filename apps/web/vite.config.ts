import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { tailnetDevServer } from "./scripts/dev-https.mjs";
import { devStaticPages } from "./scripts/dev-static-pages.mjs";
import { prerender } from "./scripts/prerender.mjs";

function cliValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("-") ? value : undefined;
}

// `pnpm dev --host <ip>` forwards the host to Vite and Wrangler. Keep the API
// proxy on the same interface so a remote VPS development session does not
// accidentally point at the browser's own localhost.
const requestedHost = process.env.FILE_SHARER_DEV_HOST ?? cliValue("--host");
const remoteHost =
  requestedHost && !["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(requestedHost)
    ? requestedHost
    : undefined;
const workerTarget =
  process.env.FILE_SHARER_WORKER_URL ??
  (remoteHost ? `http://${remoteHost}:8787` : "http://localhost:8787");

// Serving the dev app over HTTPS is not a nicety: Web Crypto, service workers
// and the camera are secure-context features, so on any address other than
// localhost an http:// URL loads the app and then breaks it. When this machine
// is on a tailnet we serve a Tailscale-issued certificate on its tailnet name,
// which every other device already trusts. `FILE_SHARER_DEV_HTTPS=0` opts out;
// so does an explicit `--host` that is not this machine's tailnet address.
function secureDevServer(command: string) {
  if (command !== "serve" || process.env.VITEST || process.env.FILE_SHARER_DEV_HTTPS === "0") {
    return null;
  }
  const tailnet = tailnetDevServer();
  if (!tailnet) return null;
  const matchesRequest =
    !requestedHost || requestedHost === tailnet.domain || requestedHost === tailnet.ip;
  return matchesRequest ? tailnet : null;
}

export default defineConfig(({ command, isSsrBuild }) => {
  const secure = secureDevServer(command);
  // Bind to the tailnet name rather than every interface: this can be a VPS, and
  // 0.0.0.0 would put an unauthenticated dev server on the public internet. The
  // name, not the address it resolves to, is what the certificate covers, so it
  // is also the only URL worth printing.
  const host = requestedHost ?? secure?.domain;
  const allowedHosts = [remoteHost, secure?.domain, secure && ".ts.net"].filter(
    (value: unknown): value is string => typeof value === "string",
  );

  return {
    plugins: [
      tailwindcss(),
      preact(),
      // Dev only: makes `public/<dir>/index.html` reachable, which Vite's static
      // layer does not resolve on its own. Without it every marketing page in
      // `public/` falls through to the SPA fallback.
      devStaticPages(),
      ...(isSsrBuild
        ? []
        : [
            // Before VitePWA: the service worker's precache manifest is globbed
            // from `dist`, and both documents have to be final by then.
            prerender(),
            VitePWA({
              registerType: "autoUpdate",
              // We register the service worker ourselves in main.tsx (bundled, so the
              // strict `script-src 'self'` CSP holds) to add periodic/focus update checks.
              injectRegister: false,
              // Custom SW (src/sw.ts): precache + root app-shell fallback, plus the
              // Web Share Target handler and Background Sync outbox flushing.
              strategies: "injectManifest",
              srcDir: "src",
              filename: "sw.ts",
              injectManifest: {
                globPatterns: ["**/*.{js,css,html,svg,woff2}"],
              },
              includeAssets: [
                "favicon.svg",
                "icon.svg",
                "icon-maskable.svg",
                "apple-touch-icon.png",
                "icon-192.png",
                "icon-512.png",
                "icon-maskable-192.png",
                "icon-maskable-512.png",
                "og.png",
              ],
              manifest: {
                name: "SendSelf",
                short_name: "SendSelf",
                description:
                  "Private, end-to-end encrypted text & file sharing between your devices",
                lang: "en",
                theme_color: "#c2410c",
                background_color: "#f8f4f2",
                display: "standalone",
                // The app opens on the spaces of this device, not the marketing
                // page: an installed PWA has already been "landed on".
                start_url: "/app",
                scope: "/",
                id: "/",
                icons: [
                  // Raster PNGs first: Android needs these to mint a WebAPK (required for
                  // the Web Share Target to register with the OS share sheet).
                  { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
                  { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
                  {
                    src: "/icon-maskable-192.png",
                    sizes: "192x192",
                    type: "image/png",
                    purpose: "maskable",
                  },
                  {
                    src: "/icon-maskable-512.png",
                    sizes: "512x512",
                    type: "image/png",
                    purpose: "maskable",
                  },
                  // The tab favicon is a bare, transparent mark; the manifest wants the
                  // boxed one, which is what an installed icon should look like.
                  { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
                  {
                    src: "/icon-maskable.svg",
                    sizes: "any",
                    type: "image/svg+xml",
                    purpose: "maskable",
                  },
                ],
                // Let the OS share sheet send text & files to this installed PWA. The
                // POST is intercepted by the service worker (src/sw/share-target.ts).
                share_target: {
                  action: "/share-target",
                  method: "POST",
                  enctype: "multipart/form-data",
                  params: {
                    title: "title",
                    text: "text",
                    url: "url",
                    files: [{ name: "files", accept: ["*/*"] }],
                  },
                },
              },
              devOptions: { enabled: false },
            }),
          ]),
    ],
    build: {
      // Avoid Vite's inline module-preload polyfill so the built index.html has no
      // inline <script> (keeps the strict `script-src 'self'` CSP working).
      modulePreload: { polyfill: false },
    },
    server: {
      port: 5173,
      ...(host ? { host } : {}),
      ...(secure ? { https: secure.credentials } : {}),
      ...(allowedHosts.length ? { allowedHosts } : {}),
      proxy: {
        // In dev, forward API calls to the local Worker (wrangler dev). `ws`
        // also carries the realtime socket, opened on the app's own origin.
        "/api": { target: workerTarget, changeOrigin: true, ws: true },
      },
    },
  };
});
