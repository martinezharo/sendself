# Documentation

This directory documents the current implementation of SendSelf. It is written for contributors and operators, not as a product manual.

If documentation and code disagree, treat the code and its tests as the current behavior and update the documentation as part of the same change. Avoid documenting roadmap ideas as if they were shipped features.

## Start here

- [Architecture](architecture.md) explains the applications, Cloudflare bindings, data flow, and storage lifecycle.
- [Security](security.md) describes the cryptographic protocol, trust boundaries, threat model, and known limitations.
- [Development](development.md) covers local setup, secure contexts, tests, and browser tooling.
- [Deployment](deployment.md) covers D1/R2 provisioning, migrations, and the release sequence.
- [API](api.md) lists the Worker routes and their authentication rules.

## Other sources

- [Worker package notes](../apps/worker/README.md) contains commands specific to the Worker package.
- [TODO](../TODO.md) tracks remaining product and engineering work.
- [Audit](../AUDIT.md) records deferred decisions and the verification that was performed for earlier changes.
- [Wrangler configuration](../apps/worker/wrangler.jsonc) is the authoritative binding and trigger configuration.
- [Shared contracts](../packages/shared/src/index.ts) are the authoritative TypeScript API shapes and protocol statement formats.
