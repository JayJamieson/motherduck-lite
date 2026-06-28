# motherduck-lite

A minimal MotherDuck-shaped service: DuckDB served over the Quack protocol on
Cloudflare Containers, with read/write durability via the Sandbox
backup/restore API, fronted by a Worker as the TLS-terminating proxy.

This is a proof-of-concept scaffold.

## Architecture

```
DuckDB quack client
      │  HTTPS (token = QUACK_TOKEN)
      ▼
Cloudflare edge ──► Worker (src/index.ts)        TLS terminated here
      │              • resolve db id  (?db=…, default "default")
      │              • tag request x-mdl-proxy: quack
      ▼
DuckSandbox  (src/DuckSandbox.ts)   one DO per db  ->  one container  ->  single writer
      • boot(): restoreBackup(latest handle) -> startProcess(quackhost) -> waitForPort(9494)
      • alarm(): FORCE CHECKPOINT -> chmod -> createBackup -> persist handle  ← durability loop
      • fetch(): containerFetch(:9494)   (port never publicly exposed)
      ▼
container (container/…)
      • /app/quackhost (Go): CALL quack_serve on /work/main.duckdb
        + localhost admin :8088 /checkpoint  + SIGTERM final checkpoint
      ▼
R2  (BACKUP_BUCKET)   squashfs snapshots
```

## Prerequisites

- Node 22+ and pnpm
- Go 1.24+ (to build the container's Quack host)
- Docker (Wrangler builds the container image locally before deploy)
- A Cloudflare account with Workers + Containers + R2 enabled, and Wrangler
  authenticated: `npx wrangler login`
- A DuckDB client ≥ 1.5.3 for testing (the `duckdb` CLI is easiest)

## Setup

```bash
pnpm install

# Generate go.sum for the Quack host, then enable its COPY in the Dockerfile.
cd container/quackhost && go mod tidy && cd ../..

# Create the R2 bucket used for snapshots (name must match wrangler.jsonc).
npx wrangler r2 bucket create mdl-backups

# Pick a strong shared token - this is the client credential AND the server token.
npx wrangler secret put QUACK_TOKEN
```

Two things to confirm before first deploy (see _Known gaps_): the
`@cloudflare/sandbox` version in `package.json` matches the
`cloudflare/sandbox:<tag>` base image in `container/Dockerfile`, and the
`go-duckdb` pin bundles DuckDB ≥ 1.5.3.

## Deploy

```bash
npx wrangler deploy
```

Wrangler builds `container/Dockerfile`, pushes the image, and provisions the
Worker, the `DuckSandbox` Durable Object, and the container. First boot of a
given database is lazy: it happens on the first request for that `?db=` id
(restore-or-create -> start Quack -> expose). Note the deployed Worker URL.

## Local dev

```bash
cp .dev.vars.example .dev.vars     # set QUACK_TOKEN locally
LOCAL_DEV=true npx wrangler dev     # backups use the R2 binding directly
```

`LOCAL_DEV=true` makes `createBackup` use the bound bucket instead of presigned
R2 credentials. Local container runs need Docker available.

## Connect & test

Point a DuckDB client at the Worker. The shared token is supplied as the Quack
secret; `?db=` selects the logical database (defaults to `default`).

```sql
-- in the duckdb CLI
CREATE SECRET (TYPE quack, TOKEN '<QUACK_TOKEN>');
ATTACH 'quack:https://<your-worker-host>/?db=default' AS w;
USE w;

CREATE TABLE t AS SELECT i, i*i AS sq FROM range(10) r(i);
SELECT count(*), max(sq) FROM t;          -- 10 | 81
```

To verify durability end to end:

1. Insert data, then wait past one reaper interval (`REAPER_MS`, 60s) so a
   snapshot lands in R2 - or trigger it sooner by lowering `REAPER_MS`.
2. Force a cold start: redeploy, or let the container idle past `sleepAfter`
   (10m). The next query re-restores from the latest snapshot.
3. Re-`ATTACH` and confirm the rows are still there.

A scripted smoke test is in `scripts/smoke-test.sh`:

```bash
WORKER_URL=https://<your-worker-host> QUACK_TOKEN=<token> ./scripts/smoke-test.sh
```
