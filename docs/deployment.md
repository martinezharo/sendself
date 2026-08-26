# Deployment

SendSelf deploys as one Cloudflare Worker. The Worker serves the built PWA and `/api/*`; D1 stores metadata, R2 stores encrypted file blobs, a cron trigger performs cleanup, and a Durable Object provides per-space WebSocket notifications.

## How a release happens

Pushing to `main` deploys. The repository is connected to Cloudflare Workers Builds, which on every push runs `pnpm run build` and then `pnpm --filter @file-sharer/worker run deploy`, and publishes the resulting version. There is no deploy step in GitHub Actions: `.github/workflows/ci.yml` only lints, typechecks, tests and builds.

The migration guard and the schema update therefore live inside the Worker package's own `deploy` script rather than in a root release script. That is deliberate: it is the command Workers Builds runs, so the automated path and a manual one cannot diverge, and there is no longer a `wrangler deploy` shortcut that quietly skips migrations.

Deploying by hand — for a first deployment, or when the Git connection is unavailable — is the same sequence from the repository root. Use `pnpm run deploy`, not `pnpm deploy`: pnpm reserves the latter for its own workspace deployment command.

## Cloudflare resources

The names and bindings are declared in [`apps/worker/wrangler.jsonc`](../apps/worker/wrangler.jsonc):

| Resource | Binding | Current name/purpose |
| --- | --- | --- |
| D1 | `DB` | `file-sharer-db`, metadata and delivery state. |
| R2 | `FILES` | `file-sharer-files`, encrypted file blobs. |
| Durable Object | `SPACE_HUB` | One `SpaceHub` instance per space for sync notifications. |
| Rate limiters | `RL_PUBLIC`, `RL_WRITE`, `RL_UPLOAD` | Edge abuse protection; absent in local dev and Worker tests. |

The deployed Worker also runs an hourly cleanup trigger. The R2 lifecycle rule is configured on the bucket, not in `wrangler.jsonc`.

## One-time resource setup

Authenticate Wrangler with an account that can manage the Worker, D1, R2, Durable Objects, and rate-limit bindings. Then create or select the resources:

```bash
pnpm --filter @file-sharer/worker exec wrangler d1 create file-sharer-db
pnpm --filter @file-sharer/worker exec wrangler r2 bucket create file-sharer-files
pnpm --filter @file-sharer/worker exec wrangler r2 bucket lifecycle add file-sharer-files expire-24h --expire-days 1
```

Copy the D1 `database_id` printed by Wrangler into `apps/worker/wrangler.jsonc`. The id is an identifier, not a credential; account credentials and tokens must not be committed.

Verify the lifecycle rule:

```bash
pnpm --filter @file-sharer/worker exec wrangler r2 bucket lifecycle list file-sharer-files
```

Apply the remote schema when provisioning a new database:

```bash
pnpm db:migrate:remote
```

Every deployment also applies pending remote migrations, so this is mainly a provisioning or schema-only operation.

## Release sequence

Whether it is triggered by a push or run by hand, the order is the same:

1. `pnpm --filter @file-sharer/web build` renders the SSR bundle, then builds the PWA and its service worker, prerendering the public page (`index.html`) and the app shell (`app.html`) into `dist`. Workers Builds runs this as its build command.
2. `pnpm --filter @file-sharer/worker run deploy` — its build command — then:
   1. `scripts/check-migrations.mts` inspects migrations that are still pending on remote D1;
   2. `pnpm db:migrate:remote` applies the accepted migrations;
   3. `wrangler deploy` publishes the Worker and its static assets.

Migrations run before the new Worker is published. This is safe for additive schema changes because the old Worker can continue to use the wider schema during the short transition.

The guard reads the remote migration ledger through Wrangler. If it cannot reach it — no credentials, or a database that does not exist yet — it says so and steps aside rather than blocking, and the migration step immediately after fails on its own if the credentials really are missing. A build that lacks D1 permissions therefore fails loudly before publishing instead of deploying against an unmigrated schema.

Node is pinned by `.node-version` because the guard is TypeScript executed directly by Node, which needs a version that strips types without a flag.

## Migration compatibility

The migration guard rejects pending migrations containing operations that can break the Worker still serving traffic:

- `DROP`;
- `RENAME`;
- a `NOT NULL` column without a default.

Use an expand-and-contract rollout for incompatible changes: add the new shape, publish code that can use both shapes, stop writing the old shape, and remove it in a later deployment.

If a breaking migration is deliberately coordinated with downtime, the guard can be overridden explicitly:

```bash
ALLOW_BREAKING_MIGRATIONS=1 pnpm run deploy
```

This override is a release decision, not a routine fix. In an automated deployment it has to be set as a build variable in the Workers Builds configuration, which is deliberately inconvenient: a breaking migration should be a deliberate, supervised release, so prefer running that one by hand.

A direct `wrangler deploy` from `apps/worker` still bypasses the guard, since the sequence lives in the package's `deploy` script rather than in the binary. Use `pnpm run deploy` from the root, or push.

## Post-deploy verification

After publishing:

1. Confirm that the canonical HTTPS site loads the public page and `/app` shell.
2. Confirm that HTTP redirects to HTTPS and the `www` hostname redirects to the canonical hostname.
3. Exercise a real device flow: create or open a space, pair a second device, send text, send a file, and verify delivery after reconnecting.
4. Check Cloudflare deployment/Worker logs for errors without logging or copying credentials or plaintext.
5. Verify the R2 lifecycle configuration still exists.

The public canonical hostname currently configured in the Worker is `file-sharer.4oli.com`; if the deployment target changes, update the Worker configuration and this verification step together.

## Rollback considerations

Rolling a Worker version back does not roll D1 migrations back. Prefer additive, backwards-compatible migrations and a forward fix. Before reverting a deployment, check whether the new Worker has already depended on the new schema and whether any data has been written in the new format.
