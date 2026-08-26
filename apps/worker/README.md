# @sendself/worker

The Worker serves the PWA and `/api/*` from one Cloudflare Worker. It uses D1 for metadata and delivery state, R2 for encrypted file blobs, an hourly cleanup trigger, and one hibernating `SpaceHub` Durable Object per space.

The repository-level documentation is the canonical reference:

- [Architecture](../../docs/architecture.md)
- [Security](../../docs/security.md)
- [Development and testing](../../docs/development.md)
- [Deployment](../../docs/deployment.md)
- [API reference](../../docs/api.md)

## Package commands

```bash
pnpm --filter @sendself/worker dev
pnpm --filter @sendself/worker test
pnpm --filter @sendself/worker typecheck
pnpm --filter @sendself/worker cf-typegen
pnpm --filter @sendself/worker db:migrate:local
pnpm --filter @sendself/worker db:migrate:remote
```

`dev` applies pending local migrations before starting Wrangler. Use the root `pnpm dev` command when you also want the Vite PWA.

Worker tests run inside workerd through `@cloudflare/vitest-pool-workers`. D1 and R2 are real test bindings, `SELF` invokes the Worker as deployed, and the schema is applied from the real `migrations/` directory before each test file. The tests intentionally omit static assets and production edge rate-limit bindings because neither is needed to exercise the Worker logic.

Use the root `pnpm run deploy` command for releases. It checks and applies remote migrations before building and publishing the Worker; see [Deployment](../../docs/deployment.md).
