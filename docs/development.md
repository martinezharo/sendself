# Development

## Requirements

- Node.js 20 or newer.
- pnpm 10.33 or newer, as declared by the root `package.json`.
- A browser with Web Crypto support for manual testing.
- A shared Playwright browser installation for end-to-end tests.

## Install and run

From the repository root:

```bash
pnpm install
pnpm dev
```

The root development command starts both packages:

- the Worker through Wrangler, normally on `http://localhost:8787`;
- the Vite PWA development server, which proxies `/api` to the Worker.

The Worker package applies pending local D1 migrations before starting Wrangler. Local D1/R2 state belongs to Wrangler's local persistence and should not be confused with remote Cloudflare resources.

To run one side directly:

```bash
pnpm --filter @sendself/worker dev
pnpm --filter @sendself/web dev
```

## Secure contexts

The PWA intentionally uses the browser Web Crypto API without a plaintext-HTTP fallback, and service workers and the camera-based pairing scan are gated the same way. `http://localhost` is treated as a secure development context; an HTTP URL opened through a LAN or Tailscale address is not, so the app loads there and then fails.

The development server therefore serves HTTPS by itself whenever the machine is on a tailnet with HTTPS certificates enabled. `apps/web/scripts/dev-https.mjs` asks `tailscale cert` for a certificate for this machine's `*.ts.net` name, caches it in the gitignored `apps/web/.dev-certs/`, and renews it a week before expiry. Vite then binds to that name — not `0.0.0.0`, which on a VPS would publish the development server — and prints a single `https://<machine>.<tailnet>.ts.net:5173/` URL that other devices on the tailnet open with no certificate warning. The name is what the certificate covers; the numeric tailnet address serves the same app but fails validation. Both the API and the realtime WebSocket are proxied through that same origin.

Without Tailscale nothing changes: the server falls back to plain HTTP, where `http://localhost:5173` is still a secure context.

| Variable | Effect |
| --- | --- |
| `SENDSELF_DEV_HTTPS=0` | Forces plain HTTP. |
| `SENDSELF_DEV_HOST` / `--host` | Binds elsewhere; HTTPS stays on only if the value is this machine's tailnet name or address. |
| `SENDSELF_WORKER_URL` | Overrides the Worker the `/api` proxy forwards to. |

If the app reports that Web Crypto is unavailable, check the origin before changing application code.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm test` | Runs the package test suites. |
| `pnpm --filter @sendself/worker test` | Runs Worker tests only. |
| `pnpm test:e2e` | Builds the PWA and runs Playwright against a real Worker and browser. |
| `pnpm test:e2e:ui` | Opens Playwright's interactive UI. |
| `pnpm typecheck` | Type-checks the workspace and E2E code. |
| `pnpm lint` | Runs Biome linting. |
| `pnpm format:check` | Checks Biome formatting. |
| `pnpm build` | Builds the production PWA assets. |
| `pnpm check:migrations` | Checks pending remote migrations for known breaking operations. |

## Unit and Worker integration tests

The web package uses Vitest for crypto, storage, state, sync, and outbox behavior. Worker tests run through `@cloudflare/vitest-pool-workers`: D1 and R2 are real workerd bindings, the Worker is invoked as a deployed-style `SELF`, and the schema is built from the actual `apps/worker/migrations` directory before each test file.

This is intentional. Pairing guards, delivery cleanup, key-rotation compare-and-swap behavior, and cross-space authorization depend on SQL and Worker runtime behavior that ordinary mocks would not cover.

## End-to-end tests

`pnpm test:e2e` builds the PWA, serves it from the Worker on port 8788, and drives Chromium through Playwright. It uses `.e2e-state/` for isolated local D1/R2 persistence rather than the state used by `pnpm dev`.

The suite focuses on behavior that unit tests cannot see reliably: browser storage surviving a page restart, closing and reopening a device, service-worker hand-off, and browser navigation. It runs against the built PWA, not Vite's on-demand development transform.

Wrangler development can exit when a browser socket closes. The E2E Worker command restarts it in a loop and Playwright retries once; this is a test-server workaround, not a production runtime requirement.

Playwright browsers are not committed to the repository. Set `PLAYWRIGHT_BROWSERS_PATH` to the shared browser location used on the machine, then install Chromium there if necessary:

```bash
export PLAYWRIGHT_BROWSERS_PATH=/path/to/shared/playwright-browsers
pnpm exec playwright install chromium
```

Do not install browsers into the repository or an unmanaged user-home cache on the VPS.

## Local state and cleanup

The development and E2E commands use separate Wrangler persistence directories. Do not delete or overwrite another active session's state to free a port or reset a test. If a port is occupied, reuse the existing service when appropriate or select an isolated port.

The browser profile used by the E2E suite is created by Playwright. It is unrelated to any persistent browser profile used for other tasks on the machine.

## Where to change things

- UI and browser behavior: `apps/web/src`.
- API and Cloudflare behavior: `apps/worker/src`.
- Shared request/response types and protocol statements: `packages/shared/src/index.ts`.
- D1 schema: `apps/worker/migrations`.
- Browser flows: `e2e`.

When changing a protocol or storage invariant, update the relevant documentation in the same change and add a test at the narrowest layer that can observe the behavior.
