# LayPipe read model

Robinhood Chain is authoritative. Chain-derived tables can be deleted and
rebuilt from the deployment block; the database never authorizes a wallet
action or changes protocol state. `ipfs_promotions` is the one operational
provenance table: losing it fails safely to initials, but restoring artwork
availability requires its backup or a reviewed reconstruction from the
permanent Pinata promotion tags.

## Runtime contract

- `chain_blocks` stores canonical block identities.
- `chain_events` stores raw logs and is uniquely keyed by
  `(chain_id, transaction_hash, log_index)`.
- Source-derived rows reference their raw event with `ON DELETE CASCADE`.
- `token_balances` remains the canonical reconciliation view over immutable
  transfers. Public wallet reads use `token_holder_balance_state`, a
  statement-trigger-maintained projection keyed by chain, holder, and token;
  canonical insert, cascade rollback, and replay update it transactionally.
- EVM unsigned values use `numeric(78,0)` and cross the JavaScript boundary as
  base-10 strings or `bigint`, never `number`.
- An immutable-row trigger makes identical retries safe and rejects a retry
  whose data differs under the same block or log identity.
- Cursor advancement is a database compare-and-swap performed in the same
  serializable transaction as blocks, logs, and projections.
- Each worker completion records its pinned finalized safe head, observation
  time, and terminal status; market reads require a fresh caught-up observation
  with at most two blocks of stored lag.
- `pool_market_totals` is trigger-maintained on canonical swap insert/delete,
  so total-trade reads are constant per selected pool and reorg rollback repairs
  the aggregate automatically.
- `market_leader_snapshots` and `market_leader_entries` materialize only the
  three board leaders: trailing-24-hour most traded, newest, and biggest
  positive price mover. A fixed trigger runs only after a caught-up `laypipe`
  cursor observation and no more than once per minute per chain. Each snapshot
  references its exact canonical block identity, so a reorg cascade deletes the
  snapshot and every populated leader entry before replay. Missing, stale, or deleted
  snapshots fail new public leader reads closed; an already cached successful
  list response may remain at the CDN edge for its 10-second TTL plus 20-second
  stale window. Request handlers read at most three entry rows rather than
  globally ranking swaps.
- `ipfs_promotions` is the immutable allowlist of image/metadata CID pairs
  completed by LayPipe's normalized, wallet-authorized promotion flow. Public
  market and portfolio SQL exposes an artwork CID only when both indexed URIs
  exactly match one completed row and its wallet is the launch's original
  creator; arbitrary or copied on-chain URIs never become public gateway requests.

Back up/export `ipfs_promotions` before opening uploads and include restore
verification in disaster-recovery rehearsal. The correlated permanent Pinata
tags are recovery evidence, but this repository does not yet automate that
reconstruction; do not describe a chain-only replay as a complete artwork
restore.

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

`DATABASE_READ_URL` and `DATABASE_WRITE_URL` are server-only and are attested as
one pair before either live path runs. Both must target the same primary Neon
branch; pooled and unpooled URLs for the same Neon endpoint are accepted, but a
different endpoint or database is rejected even when it was cloned with the same
LayPipe identity marker and migration ledger. Do not serve cursor-dependent reads
from an asynchronous replica. A
missing or malformed value fails closed without breaking a frontend-only
`next build`. Runtime reads use a three-second HTTP deadline; cursor writes,
canonical batch transactions, rollbacks, and migrations use a ten-second
deadline. A timeout fails the request and never advances the canonical cursor.

Production must not expose the migration-owner credential to request handlers.
Keep `DATABASE_MIGRATION_URL` in an ignored operator environment only; never add
it to Vercel. After `npm run db:migrate`, run `npm run db:grant-runtime` with
validated `LAYPIPE_DB_READ_ROLE`, `LAYPIPE_DB_WRITE_ROLE`, and
`LAYPIPE_DB_SERVICE_ROLE` names. All three roles must already exist as safe
`NOLOGIN` groups. The service role's sole member is the migration owner with
ADMIN, INHERIT, and SET options, as PostgreSQL requires for that non-superuser
owner to maintain service-owned functions; no runtime identity may inherit it. It owns only the
exact fixed-search-path functions that maintain projections, advance cursors,
and perform validated rollback. The command revokes ambient PUBLIC/default privileges and
applies the reviewed grants. Use separate LOGIN credentials, each inheriting
exactly one read or write group, for `DATABASE_READ_URL` and
`DATABASE_WRITE_URL`; rehearse them in Preview and rotate each independently.
Runtime startup rejects unsafe LOGIN attributes, extra memberships, owned schema
objects, destructive or derived-state DML, or a migration credential present in
production. The write role includes UPDATE only where canonical `ON CONFLICT`
replay needs it; immutable-row triggers reject changed replay data. The grant
command also revokes runtime temporary-table creation and fixes every LayPipe
function search path against object shadowing.
The identity and capability handshake is cached for one warm Vercel instance;
recycle active instances after changing a credential, membership, grant, or
database branch so each instance re-attests before serving live data.
Until those roles are provisioned, keep live market,
pinning, and indexer switches disabled.

The migrations include the exact composite ordering index used by launch
keyset pagination, a partial covering per-pool swap index, and a time-leading
partial covering index used by the once-per-minute global leader refresh.
Wallet portfolio reads are same-origin, no-store JSON `POST` requests;
the address stays out of the URL, and Upstash applies both an IP limit and a
separate IP-wallet limit before Neon opens. Missing or degraded Upstash fails
this route closed in production. The wallet SQL rejects a stale watermark
inside its materialized gate before balance, creator, or accounting work and
uses `token_holder_balance_state_pkey`, `admin_events_creator_subject_idx`, and
`admin_events_creator_pool_idx` for its bounded candidate set.

Before live promotion, run `EXPLAIN (ANALYZE, BUFFERS)` on
`TOKEN_LIST_SQL`, `TOKEN_DETAIL_SQL`, and the leader-refresh query against
representative Preview volume.
The selected-launch scan should use `launches_market_page_idx`, and per-pool
latest/24-hour swap work should use `swaps_pool_market_metrics_idx` rather than
sequentially scanning all swaps. Capture the plans and table cardinalities in
the release evidence. The leader refresh should use `swaps_market_window_idx`
to bound its positive-token 24-hour window; monitor refresh duration and do not
reduce the one-minute throttle without a fresh load test. Confirm the
creator-bound CID-pair lateral join uses
`ipfs_promotions_creator_completed_cids_idx` and that a one-URI mismatch or CID
pair copied by a different creator returns no approved artwork. Also run
`WALLET_POSITIONS_SQL` for a holder, an original
creator, and a transferred current creator, plus a stale-watermark case; stale
plans must not execute the holder or creator index scans. The disposable test
proves index selection, projection replay, and cascade rollback, but do not
extrapolate latency from its tiny tables. `0000` has not
been applied to a shared environment as of this candidate; freeze its digest
after the first Preview application and use a new numbered migration for every
later schema change.

The 24-hour price baseline is the newest canonical positive-token swap at or
before the exact canonical cutoff timestamp. A swap exactly at the cutoff is a
baseline and is not counted in trailing-window volume. When a new pool has no
pre-cutoff swap, its first swap strictly after the cutoff is the fallback
baseline; it needs a second in-window swap to qualify as a mover. Existing
pools can qualify from one in-window swap plus their cutoff baseline. Board,
detail, and the materialized global mover use this same definition. Migration
`0003_market_baseline_semantics.sql` replaces only the leader refresh function;
the earlier migration files remain immutable.

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
The same CI opt-in also runs `tests/postgres-privileges.test.mjs`, which proves
NOLOGIN group-role inheritance through separate LOGIN credentials, exact
read/write capability matrices, denied DDL/delete operations, idempotent IPFS
registry retry, immutable-row rejection, and removal of ambient PUBLIC function
execution.

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
complete audited-manifest preflight for that invocation. Its ingestion/RPC
boundary reserves the final 22 seconds for an in-flight canonical write, the
terminal observation and leader refresh, response serialization, and lease
release inside the 60-second route. The watched launch set
is capped at
`INDEXER_FILTER_CHUNK_SIZE * INDEXER_MAX_FILTER_CHUNKS` (2,500 by default);
crossing it stops before cursor advancement and requires an intentionally
designed sharded stream or provider-specific filter plan.

The manifest deployment block must be the earliest mined receipt block among
the factory implementation/proxy, hook, routers, burner, and every other
watched deployment transaction. Using the proxy or final configuration receipt
would permanently skip earlier constructor or governance events.

The canonical decoder covers launches, PoolManager swaps, holder transfers,
hook fee accrual/sweep/claim/platform-payout events, self-burn execution,
PIPEDOG revenue allocation/sequester/treasury/operations routes, and the
governance events emitted by the audited factory, hook, and revenue router.
Every projected amount stays in exact integer base units, every selector is
checked against the committed contract ABI bundle, and every row is written in
the same canonical block transaction so rollback cascades remove it before a
replay. No Vercel scheduler or Alchemy webhook is created by the repository;
activate one only after Preview backfill and retry/concurrency testing succeeds.

Events intentionally retained only as raw chain activity or omitted from the
watched filters:

- `PoolRegistered` duplicates the factory `TokenLaunched` identity and its
  nested config is already bound by the audited manifest plus token reads.
- `FirstBuyRefunded` and `LaunchLiquiditySeeded` are launch-execution detail,
  not fee/revenue-accounting lanes; the launch event, canonical swap, and token
  transfers remain authoritative.
- `LaypipeSwapRouter.Bought` / `Sold` duplicate the canonical PoolManager swap
  and would double-count volume.
- unrelated-token/native recovery events are stored as admin evidence, not
  PIPEDOG revenue totals. Factory PIPEDOG recovery is also admin evidence rather
  than a normal fee lane. Revenue-router `Migrated` is likewise an auditable
  custody/admin escape, never a normal routing lane.
- dividend-distributor round events remain unindexed while dividend launches
  are contractually disabled and that design is under review.

Reconciliation is event-led: accrued fees reconcile to swept creator/platform
lanes plus current on-chain pending state; creator claims reconcile against the
swept creator lane; deferred versus collected platform payouts reconcile to
the hook platform tab; routed amount plus keeper bounty reconciles against its
allocated revenue tank; and self-burn events report quote actually spent,
tokens actually burned, and the paid bounty. Operational monitoring should
periodically compare event totals to the audited contracts' public counter and
balance views before production alerts are enabled.

Run the executable, read-only gate with an explicit finalized block:

```text
RECONCILIATION_BLOCK_NUMBER=<decimal block> npm run db:reconcile
```

It uses the same complete production manifest, HTTPS RPC, database, and
`INDEXER_FINALITY_BLOCKS` as ingestion. It checks the canonical stored block,
per-pool hook tabs, router counters/tanks, self-burn fuel and burn transfers,
and every indexed launch token's total supply at that exact block. It refuses
unallocated router PIPEDOG, router migration history, more than 100 pools by
default, or any mismatch. Raise `RECONCILIATION_MAX_POOLS` deliberately (hard
limit 2,500); RPC concurrency is bounded by
`RECONCILIATION_RPC_CONCURRENCY`. Destination-wallet balances and the source
of direct router donations are intentionally not treated as cumulative
accounting counters.

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
