# SendSelf

SendSelf is an end-to-end encrypted PWA for sharing text and files between your own devices. It is designed to feel like a private chat that works asynchronously: devices can be offline when a message is sent and catch up later.

## What it provides

- Text and files up to 50 MiB per file.
- Encrypted spaces that can be shared by multiple devices.
- Device pairing, per-device authentication, device roles, and revocation.
- Real-time delivery hints with polling as the reliable fallback.
- Optional at-rest protection for the local browser store.
- A Cloudflare Worker serving the PWA and API from one origin.

The application-level security model and its limitations are documented in [Security](docs/security.md). The project is not independently security-audited.

## Quick start

Requirements: Node.js 20 or newer and pnpm 10.33 or newer.

```bash
pnpm install
pnpm dev
```

`pnpm dev` applies local D1 migrations and starts the Worker and Vite development server. Open the URL printed by Vite. Web Crypto requires a secure context, so on a tailnet the development server issues its own trusted certificate and prints an `https://…ts.net` URL that any of your devices can open; otherwise use `http://localhost`, which browsers also treat as secure. See [Development](docs/development.md) for HTTPS details and test setup.

## Common checks

```bash
pnpm test           # unit and Worker integration tests
pnpm test:e2e       # Playwright against a built PWA and isolated local Worker
pnpm typecheck
pnpm lint
pnpm build          # production PWA build
```

## Documentation

Start with the [documentation index](docs/README.md), which links the
architecture, security model, development, deployment, and API guides. The
[Worker package notes](apps/worker/README.md) cover package-specific commands;
[TODO.md](TODO.md) and [AUDIT.md](AUDIT.md) record open design work and deferred
decisions.

## Project status

This repository is intentionally an early WIP. In particular, metadata privacy, replay/order protection, automatic local retention, closed-app notifications, and some lifecycle flows remain open design or roadmap items. Start with [TODO.md](TODO.md) and [AUDIT.md](AUDIT.md) before treating the current implementation as a finished product.
