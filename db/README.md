# LayPipe read model

Robinhood Chain is authoritative. This database can be deleted and rebuilt
from the deployment block; it never authorizes a wallet action or changes
protocol state.

## Runtime contract

- `chain_blocks` stores canonical block identities.
- `chain_events` stores raw logs and is uniquely keyed by
  `(chain_id, transaction_hash, log_index)`.
- Source-derived rows reference their raw event with `ON DELETE CASCADE`.
- `token_balances` is a view over immutable transfers, so rollback never needs
  to repair a mutable balance cache.
- EVM unsigned values use `numeric(78,0)` and cross the JavaScript boundary as
  base-10 strings or `bigint`, never `number`.
- An immutable-row trigger makes identical retries safe and rejects a retry
  whose data differs under the same block or log identity.
- Cursor advancement is a database compare-and-swap performed in the same
  serializable transaction as blocks, logs, and projections.

## Dependencies and migration

Required runtime package: `@neondatabase/serverless`. The repository uses the
driver directly and keeps the migration source as reviewed SQL; it does not
require an ORM or Drizzle.

Required development packages: `dotenv-cli` and `tsx`.
Standalone scripts do not load `.env.local`; run the migration with an ignored
environment file explicitly:

```powershell
npx dotenv -e .env.local -- npx tsx scripts/indexer/migrate.ts
```

`DATABASE_URL` is server-only and required lazily when the data layer is first
used. A missing or malformed value fails closed without breaking a frontend-only
`next build`.

## Disposable PostgreSQL integration test

The normal test suite skips the real-PostgreSQL check so CI does not require a
Docker daemon. To apply the reviewed migration through the production migration
planner and exercise canonical ingest, rollback/replay, and the exact live-market
queries against an isolated PostgreSQL 16 container, opt in explicitly:

```powershell
$env:LAYPIPE_RUN_POSTGRES_INTEGRATION = "1"
node --test tests/postgres-integration.test.mjs
Remove-Item Env:LAYPIPE_RUN_POSTGRES_INTEGRATION
```

The test publishes no host port, gives the container no network, and removes
the container and its temporary data volume on completion. Override
`LAYPIPE_POSTGRES_IMAGE` only when validating another supported PostgreSQL image.

## Reorg procedure

1. Load a bounded newest-first window with `loadRecentStoredBlocks`.
2. Compare each height with archive RPC using `findCommonAncestor`.
3. If no common ancestor exists within the bound, stop and increase the audit
   window; never guess.
4. Call `rollbackChainTo` with the exact stored ancestor height and hash.
5. Cascades delete later raw events and every derived row atomically; cursors
   move back to the ancestor.
6. Replay forward with `ingestCanonicalBatch`.

The rollback function validates the ancestor hash before deleting anything.
It cannot roll back to a caller-supplied height whose stored hash differs.

## Canonical ingestion routes

`GET` or `POST /api/indexer/sync` runs one bounded catch-up invocation when
authorized with `Authorization: Bearer $CRON_SECRET`.
`POST /api/indexer/webhook` verifies
Alchemy's `X-Alchemy-Signature` against the exact raw UTF-8 request body with
HMAC-SHA256, validates the envelope, and then runs that same cursor-backed
batch. Webhook payload logs are deliberately not inserted directly: retries,
out-of-order notifications, and provider-specific payload shapes never become
a second source of chain truth.

The envelope `type` is shape-checked but is not used as an event allowlist.
Alchemy issues the signing key for the configured webhook, and every valid
signed type has the same narrowly bounded effect here: wake the canonical RPC
cursor once. The route ignores the envelope's event/log contents entirely.

Both routes acquire a 60-second Upstash lease before RPC work. A duplicate
wake-up receives HTTP 202 with `status: busy`, which acknowledges the webhook
without creating a retry storm. The lease token is compared before deletion
and expires after a crash; the serializable Postgres cursor compare-and-swap
remains the final correctness boundary if invocations ever overlap.

Each run:

- parses the complete Robinhood production deployment manifest and rejects
  test manifests;
- verifies chain ID, every pinned runtime codehash, the EIP-1967 factory
  implementation, component bindings, owner, and revenue destinations at the
  finalized block; the read-only worker accepts the global launch switch in
  either its deliberately paused staging state or its active state, while all
  wallet mutations continue to require the active state;
- checks the stored cursor hash, finds a bounded common ancestor on mismatch,
  rolls back by exact stored hash, and replays;
- queries only the pinned factory's `TokenLaunched` topic, the pinned
  PoolManager's `Swap` topic filtered by known LayPipe pool IDs, and `Transfer`
  topics from known LayPipe token addresses;
- requires every launched token to be the exact EIP-1167 clone of the pinned
  token implementation, rechecks immutable factory/pool/hook/creator bindings,
  and reads bounded on-chain metadata at the exact `TokenLaunched` block; and
- commits blocks, raw logs, launch/swap/transfer projections, and cursor CAS in
  one serializable database transaction.

`INDEXER_ENABLED=true`, `INDEXER_FINALITY_BLOCKS`, the production HTTPS RPC,
database URL, complete audited manifest, and a 32-byte cron secret are required.
The default 10-block batch is compatible with Alchemy's Robinhood free-tier
`eth_getLogs` range. One wake-up catches up at most 25 such batches (250 blocks)
within the 45-second internal deadline and pins one finalized safe head plus one
complete audited-manifest preflight for that invocation. The watched launch set
is capped at
`INDEXER_FILTER_CHUNK_SIZE * INDEXER_MAX_FILTER_CHUNKS` (2,500 by default);
crossing it stops before cursor advancement and requires an intentionally
designed sharded stream or provider-specific filter plan.

This first operational decoder covers launches, canonical PoolManager swaps,
and holder transfers. Hook fee events, self-burn events, revenue routing, and
admin events still need deterministic decoders and reconciliation tests before
those corresponding database tables can be described as live-indexed. No
Vercel scheduler or Alchemy webhook is created by the repository; activate one
only after Preview backfill and retry/concurrency testing succeeds.

Choose a webhook/block-notification cadence and RPC tier whose sustained
capacity exceeds Robinhood's block production rate. The bounded catch-up loop
does not turn a daily Hobby cron into viable primary ingestion. Alert on
`status: bounded` or `status: deadline`, cursor lag, lease contention, and RPC
rate-limit errors; increase invocation frequency before increasing the
10-block `eth_getLogs` window.

Swap side follows v4's executable caller-delta semantics, not the ambiguous
interface prose: `PoolManager` emits `Pool.swap`'s `BalanceDelta` directly.
Because PIPEDOG is currency0, a buy is `amount0 < 0 && amount1 > 0`; a sell is
the inverse. LayPipe's exact-output integration tests assert those same signs.
