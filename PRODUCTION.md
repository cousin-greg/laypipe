# LayPipe production runbook

This file is the release gate for `laypipe.fun`. Chain state is authoritative;
Postgres is a rebuildable chain read model plus the fail-safe artwork promotion
registry described below. No launch or trading control should be
enabled until every required contract address is configured and verified.
Use [LAUNCH_CHECKLIST.md](./LAUNCH_CHECKLIST.md) as the short owner/operator
sequence and [contracts/AUDIT_HANDOFF.md](./contracts/AUDIT_HANDOFF.md) for the
immutable external-review package; this runbook remains the detailed authority.

## Current Vercel resource status

- The `laypipe-production` Neon integration is attached to Production and
  Preview. Preview database branching is enabled, so preview migrations and
  data do not touch the production branch.
- The `laypipe-production-rate-limits` Upstash database still needs to be
  accepted and verified in the Vercel Marketplace for Production. Until its
  injected REST URL/token are confirmed by a fail-closed smoke test, upload
  and mutation routes must remain disabled. Preview must use a separate Redis
  resource and must never share Production nonce or rate-limit state.
- `NEXT_PUBLIC_SITE_URL`, `LAYPIPE_MARKET_MODE=fixture`, a production
  wallet-challenge secret, a production cron secret, and the
  `IPFS_PINNING_ENABLED=false` kill switch are configured in Vercel. Pinata
  publishing remains disabled.
- The initial Neon schema has not been applied yet. Vercel requires Greg's
  two-factor confirmation in the open Query dialog before that database write.

## Remaining accounts and decisions

1. **Pinata** — create a public-IPFS project and provide a server-only JWT plus
   its dedicated gateway base URL. The token-art upload endpoint must never
   receive this credential in the browser.
2. **Alchemy** — create Robinhood Chain Mainnet HTTP and WebSocket endpoints
   and an authenticated webhook. HTTP backfill plus webhooks is the primary
   ingestion path; WebSocket is an optional operational fallback. Public RPC
   is not production indexing infrastructure.
3. **Protocol control** — provide separate Safe addresses for final owner,
   treasury, and operations. Do not use the deployment EOA as the permanent
   administrator or revenue destination.
4. **Economic sign-off** — approve supply, target starting FDV in PIPEDOG,
   launch fee, per-call routing and self-burn caps, keeper bounties, and the
   exact platform revenue split.
5. **Independent audit** — complete an external review before any deployment
   transaction is broadcast, including a public testnet deployment.

## Open protocol release blockers

- Keep the self-burn launch configuration disabled. Its current permissionless
  burn call is a public market order without an independent on-chain price
  reference, so a searcher can manipulate the pool around the protocol-funded
  buy. Per-call caps limit loss but do not make execution safe. An audited
  TWAP/oracle or otherwise bounded execution design is required before this
  mode can be enabled. The production manifest pins this config as disabled,
  and the launch form defaults to creator fees and does not offer self-burn.
- No launch configuration is approved yet. Supply, aligned start tick,
  executable curve depth, price impact, caps, bounties, and launch fee require
  PIPEDOG-denominated simulation and written sign-off. The strict
  `contracts/scripts/simulate-curve.mjs` gate must pass with its exact
  source-pinned approval hash and retained report. The historical tick `204200`
  is explicitly not a production default.
- Put factory ownership behind a Safe plus a reviewed timelock/guardian plan.
  Exact approvals reduce exposure, but an immediately upgradeable spender can
  still exploit the allowance window if its owner is compromised. The wallet
  must verify the pinned implementation immediately before both approval and
  launch.
- Decide whether the revenue router's owner migration power is acceptable as
  disclosed policy or must be timelocked/limited before launch. The normal
  25/25/50 routing split is not irrevocable while that migration path exists.
  Migration now requires the router to be paused and the successor to be a
  contract reporting the same PIPEDOG token, but those operational checks are
  not a delay and do not constrain a malicious owner.
- Keep the EIP-1153 runtime gate green. Robinhood mainnet support was proved by
  read-only `eth_call` at block `34176993` (hash
  `0xf8cbda286e1e06fa8058360d47fd71df6678a99f6a76251a8b58486e2bdb3917`) on
  2026-08-12 UTC. `contracts/scripts/check-robinhood-eip1153.mjs` confirms
  chain `4663`, pins both calls to one canonical block hash, requires a
  `TSTORE`/`TLOAD` round-trip to return `0x2a`, and requires an invalid-opcode
  control to fail. Re-run it against the intended production RPC immediately
  before audit and release; a future runtime change must fail closed.

Copy `.env.example` to an ignored `.env.local` for local work. Put production
values in Vercel's encrypted environment settings. Never place database,
pinning, webhook, Redis, or wallet secrets in a `NEXT_PUBLIC_` variable.
Production and Preview must use different database, Redis, cron, webhook, and
pinning credentials. Until a separate Preview Redis resource exists, keep its
upload and mutation APIs disabled. Mark every server-only credential as
Sensitive in Vercel.
Restrict the Pinata key to only the file and JSON pinning permissions this app
uses. Database clients must initialize lazily so an intentionally unconfigured
Preview build fails at request time rather than during `next build`.

Database access is split deliberately. `DATABASE_READ_URL` serves market,
wallet, and reconciliation reads; `DATABASE_WRITE_URL` serves IPFS registry and
canonical indexer work. They use separate rotatable LOGIN credentials, each
inheriting exactly one reviewed read/write NOLOGIN role, and must target the same
primary Neon branch. A third NOLOGIN service role owns only the exact fixed-path
maintenance functions; its sole ADMIN member is the operator-only migration
owner, with the INHERIT and SET options required to maintain those functions,
never a runtime identity. Keep
`DATABASE_MIGRATION_URL` operator-local and out of Vercel. After every migration,
run `npm run db:grant-runtime` as the owner and rerun the PostgreSQL privilege
integration before either runtime URL is enabled.

The complete public audited-deployment manifest is the canonical contract
configuration for both the browser and indexer. A factory address alone never
enables wallet mutations. The manifest pins chain `4663`, deployment block,
full audited source commit, compiler version, ABI and artifact bundle hashes,
the proxy and EIP-1967 implementation identities, every component address and
runtime codehash, final governance and revenue destinations, both launch
configs, launch fee, routing caps, and keeper bounties.

Before every approval or launch submission, the browser takes one block
snapshot and requires exact matches for all runtime codehashes, the EIP-1967
implementation slot, factory/hook/burner/router bindings, accepted Safe
ownership with no pending owner, revenue destinations and pause state, routing
caps and bounties, launch fee, and every launch-config field. Missing manifest
fields, unsupported RPC responses, bytecode replacement, proxy upgrade,
ownership drift, or configuration drift fail closed. Do not cache a successful
preflight across wallet mutations.

Approval and launch submission are crash-safe browser workflows. Immediately
before `eth_sendTransaction`, the client repeats the complete audited deployment
verification and then re-reads the active account and chain. It saves a
wallet/action/predicted-token intent in local storage before invoking the send
method and saves the returned hash before waiting. Only an explicit EIP-1193
`4001` rejection is retry-safe after the wallet prompt begins; transport,
provider, malformed-hash, callback, timeout, and unknown errors leave the intent
locked across reloads and navigation until wallet activity is reconciled.

Receipts are confirmed through an independent Robinhood RPC, not the injected
wallet provider. Confirmation requires two canonical blocks, exact transaction
hash/from/to/input, zero native value, matching receipt and block hashes, and
transaction inclusion in that block. Approval confirmation also re-reads the
exact allowance at the receipt block. Launch confirmation requires exactly one
audited-factory `TokenLaunched` event, the mined token and creator, submitted
config/first-buy values, audited hook and fee recipient, plus the launched
token's `poolId()` matching the event. A real browser and hardware-wallet
rehearsal remains a release gate; unit fixtures do not prove wallet UX or public
RPC behavior.

`lib/web3/chains.ts` contains a Base Sepolia rehearsal descriptor, and
`createBaseSepoliaTestManifest` requires an explicit test-only acknowledgement.
The production environment parser has no network switch and can only construct
the pinned Robinhood manifest. Do not add Base test addresses or a mock quote
token to Production or Preview variables.

## Backend and indexing shape

The indexer stores raw canonical logs before deriving launches, swaps, fee
routes, sequestration, burns, balances, and admin events. Every log is keyed by
`(chain_id, transaction_hash, log_index)`. Stored block hashes permit rollback
to a common ancestor after a reorg, then deterministic replay.

Use `numeric(78,0)` for EVM integers and serialize them as decimal strings.
Never coerce token amounts to JavaScript `number`.

Public read routes use keyset pagination and short CDN caching. Health and
mutation routes use `no-store`. Every successful worker wake-up stores its
pinned finalized safe head, terminal status, and observation time. Live health,
board, and token-detail reads fail closed when the cursor is uninitialized, the
observation is missing or more than five minutes old, the last run did not
finish caught up, or the cursor is more than two blocks behind that safe head.
`/api/health` remains deployment liveness in fixture mode; `/api/ready` is the
market-read readiness probe and returns 503 unless live mode and its database
and indexer gates are ready. It does not prove launch mutation readiness:
manifest/RPC, Redis, Pinata, and wallet flows retain separate release gates.
Keyset cursors are HMAC-authenticated with a
domain-separated use of the server-only wallet challenge secret, so arbitrary
client-generated cursor variants fail before Neon. Indexer work is bounded by
block batch, guarded by `CRON_SECRET`, idempotent, and safe to retry.

Before switching market reads to `live`, stage Vercel WAF rules in log-only mode for GET
traffic to `/api/tokens` and `/token/*`, initially at 120 requests per minute
per IP. That is deliberately generous versus the board's four polls per minute.
Review real traffic, verify Preview, and only then publish an enforcing 429
rule. Application caching and signed cursors reduce spend; they do not replace
an edge limit for arbitrary token-address probes.

Use two method-scoped WAF rules so traffic is measurable independently:

```text
GET /api/tokens*  -> 120 requests / 60 seconds / IP, log-only first
GET /token/*      -> 120 requests / 60 seconds / IP, log-only first
```

After publishing log-only rules, review the Firewall traffic view for at least
one representative promotion window. Confirm wallet clients, social unfurlers,
search crawlers, and uptime probes are not misclassified; then enforce in
Preview, verify 429 behavior, and only afterward ask the project owner to
publish production enforcement. Vercel's automatic DDoS mitigation remains the
baseline and is not a substitute for route-specific spend controls.

The implemented canonical worker is exposed at `/api/indexer/sync` (Vercel
Cron or another scheduler with `Authorization: Bearer $CRON_SECRET`) and
`/api/indexer/webhook` (Alchemy `X-Alchemy-Signature`). The webhook signature
is HMAC-SHA256 over the exact raw body; parsed or re-serialized JSON is never
used for authentication. A signed webhook is only a wake-up signal: the worker
re-reads finalized blocks and logs from the configured HTTPS RPC and advances
the same database cursor, so webhook retries and ordering cannot fork the read
model.

The signed envelope `type` is validated as bounded text but is intentionally
not an ingestion allowlist: its event contents are ignored, and any request
signed by that webhook's configured key has only one effect—wake the same
bounded canonical RPC cursor.

Cron and webhook wake-ups share a 60-second Upstash lease. Concurrent signed
requests receive a successful HTTP 202 `busy` acknowledgement instead of a
500/retry loop; the lease expires after a crash and uses compare-before-delete
on release. The atomic Postgres cursor CAS remains the final guard against any
overlap or stale retry.

Keep `INDEXER_ENABLED=false` until the migration and Preview rehearsal are
complete. The default `INDEXER_BATCH_SIZE=10` works with Alchemy's Robinhood
free-tier `eth_getLogs` range. A wake-up processes at most
`INDEXER_MAX_BATCHES_PER_RUN=25` windows (250 blocks) under the same pinned safe
head and complete audited-manifest preflight, stopping when caught up or when
the 45-second deadline needs finalization headroom. The ingestion loop reserves
22 seconds before that deadline for a batch already completing its bounded
canonical database write, the terminal observation/global-leader refresh,
response serialization, and lease release; the RPC deadline uses the earlier
ingestion boundary. Every batch is also bounded by
total logs, new launch metadata reads, watched pool/token filter chunks, reorg
lookback, RPC response bytes, and a 45-second internal deadline. Reaching an
`eth_getLogs` result ceiling is treated as possible provider truncation and
fails before cursor advancement. The default watch set supports 2,500 launches;
larger sets require an explicit sharded-stream/filter design rather than an
unbounded function invocation.

The scheduler/webhook cadence and production RPC quota must sustain more blocks
per minute than Robinhood produces. Hobby's daily cron is not a primary
indexer. Alert on `bounded`/`deadline` responses, cursor lag, lease contention,
and provider throttling; raise wake-up frequency before widening the free-tier
10-block RPC ranges.

Do not treat Vercel Cron as a reliable retry queue: failed invocations are not
retried automatically. If a Pro-plan minute cron is chosen as the primary
wake-up, configure `/api/indexer/sync` explicitly and keep the Alchemy webhook
as an independent wake-up path; the shared lease and cursor CAS make duplicate
delivery safe. If the project remains on Hobby, use an authenticated external
scheduler or webhook because the once-daily cadence cannot maintain the read
model. The repository intentionally does not activate either schedule yet.

The canonical decoder covers launches; PoolManager swaps (including direct v4
swaps that bypass LayPipe's router); launch-token transfers; hook fee accrual,
sweeps, creator claims, deferred platform fees, and platform collections;
self-burn execution; revenue allocation/routing; and the audited protocol's
governance/admin events. Before claiming reconciliation readiness, compare
event-led fee, platform-tab, revenue-tank, burn, and admin totals against the
audited contracts' public counters and balances over a pinned block range. The
repository does not create a Vercel schedule or activate an Alchemy webhook
automatically.

Before enabling live reads or contract controls, run
`RECONCILIATION_BLOCK_NUMBER=<finalized decimal block> npm run db:reconcile`
with the production manifest/RPC/database environment. A nonzero exit is a
release stop; retain the secret-free JSON report with the release evidence.

Intentional exclusions prevent double-counting: hook `PoolRegistered` repeats
the factory launch identity; swap-router `Bought` / `Sold` repeat canonical
PoolManager volume; and factory refund/liquidity-seed events are execution
detail rather than fee lanes. Unrelated-token/native recoveries and router
migration remain admin evidence rather than revenue. Dividend round events stay
outside the production stream while dividend launches are contractually
disabled. See `db/README.md` for the field-level reconciliation model.

`LAYPIPE_MARKET_MODE=fixture` is the safe deployment default. `live` explicitly
selects the Neon-backed API; an unavailable database or indexer returns an
error/empty readiness state and never silently substitutes fixture prices.

## Artwork and metadata flow

The browser validates and hashes a PNG, JPEG, or WebP, then signs a short-lived
EIP-191 challenge binding its wallet and exact file digest. The same-origin
stage endpoint returns a 60-second Pinata upload URL, and the browser sends the
raw file directly to Pinata so Vercel's request-body limit is never in the data
path. A second signed challenge binds the returned CID/file ID, SHA-256, and
canonical launch metadata. The final same-origin pin endpoint re-fetches the
immutable staged CID, verifies the Pinata tags and wallet, enforces the 5 MB
cap, inspects the actual file signature, decodes and deterministically
re-encodes it as WebP, removes embedded metadata, and rejects SVG.

Pin the normalized image first. Create deterministic token metadata whose
`image` field is `ipfs://<image-cid>`, then pin that JSON. The launch transaction
must pass the image URI as `TokenParams.logo` and the metadata URI as
`TokenParams.metadataURI`. The pin route records the exact completed promotion,
wallet, digest, normalized image CID, and metadata CID in `ipfs_promotions`
before returning success. That write is immutable and idempotent; a missing or
malformed `DATABASE_WRITE_URL` stops publishing before any new permanent upload,
and a database write failure prevents success after the pins are durable so the
same request can repair the registry without repinning.
A gateway URL is a delivery convenience; `ipfs://` is the durable identity.

Board, token-detail, and wallet portfolio reads expose a gateway image only
when both indexed on-chain URIs exactly match one completed promotion record and
its wallet equals the launch's original creator. A direct factory caller can
still put arbitrary or another creator's approved URIs on-chain, but those tokens
render as initials. Public reads never query Pinata to validate artwork and never
translate an unapproved CID into a fetchable URL.
Back up `ipfs_promotions` before opening uploads. Its loss does not affect token
ownership or trading and fails safely to initials, but artwork availability is
not restored by chain replay alone; retain the correlated permanent Pinata tags
and rehearse restoring the registry export.

The pin route returns `{ image, metadata, metadataDocument }`. Before requesting
any allowance, the browser rebuilds the expected document from the reviewed
form and returned image URI and requires an exact deep match with
`metadataDocument`. Any missing field, URI/CID mismatch, or metadata mismatch
fails closed before a wallet transaction.

While the self-burn contract path is release-blocked, `/api/ipfs/pin` accepts
creator-mode metadata only; this is enforced by the server as well as the form.
The exact staged-file/pin-digest pair has a 90-day Upstash progress record and
a separate 50-second owner lease. Image and metadata progress is saved between
attempts and resumes without the raw stage once a permanent image has been
recorded. A still-pending promotion must be restaged after raw-stage cleanup.
Completed response JSON is replayable exactly, and all Redis/Pinata
work shares a 45-second deadline. The browser makes at most one bounded retry
within a 65-second budget using the same signed request.

Every permanent upload is tagged with `laypipe_promotion`,
`laypipe_promotion_part`, `laypipe_pin_digest`, and `laypipe_stage_file`. If a
provider commits an upload but loses the response, use those tags with the
Upstash promotion record to identify the incomplete pair. Do not delete or add
an age-based cleanup rule for `token-artwork` or `token-metadata`: the current
protocol has no launch expiry, and a returned URI may already be referenced by
an immutable launch.

Permanent pre-launch pins are an explicit storage-cost risk: signed IP/wallet
limits are abuse friction, not Sybil resistance. Before opening uploads, set a
monthly Pinata byte/file budget and alert at 50%, 75%, and 90%; publish the
accepted orphan-cost ceiling and disable `IPFS_PINNING_ENABLED` when it is
reached. A deposit or factory-enforced expiry would be a new audited protocol
boundary, not an operations-only cleanup rule.

Upstash rate-limits IPs and wallets and consumes every challenge nonce once;
the final nonce permits only an exact idempotent retry of its promotion ID.
`/api/ipfs/cleanup`, authorized by `CRON_SECRET`, deletes only validated
`laypipe_stage=true` files older than one hour, with bounded pagination and a
100-file deletion cap. Choose a recurring scheduler before enabling uploads;
the Hobby-plan daily cron ceiling is not sufficient for sustained heavy launch
traffic. Permanent artwork and metadata pins are never selected for cleanup.

The server parses returned CIDs with a multiformats implementation; browser
regex checks are only an early error message. Non-zero first buys remain
disabled until the application can derive a deterministic on-chain quote and
apply user-selected slippage instead of asking users to guess a minimum.

## Observability and incident response

Failed operational requests emit bounded route/status summaries; indexer and
cleanup jobs emit one secret-free terminal domain summary including worker
status, safe head, next block/lag, rollback count, or cleanup truncation and
failure totals. They never log authorization headers, RPC URLs, wallet
signatures, webhook bodies, or environment values. Routine liveness and market
poll successes rely on Vercel's native request metadata to avoid log spend.

Before promotion:

1. Verify `/api/health` returns liveness and `/api/ready` returns 200 in Preview
   live mode only while the isolated indexer is caught up. Confirm readiness
   returns 503 for a bounded run, excess block lag, and a five-minute pause.
2. In Vercel Runtime Logs, save filters for `/api/ready`,
   `/api/indexer/sync`, `/api/indexer/webhook`, and `/api/ipfs/cleanup`.
3. If the plan supports Observability Plus, subscribe the owner to error and
   usage-anomaly alerts. Otherwise use an external monitor against
   `/api/ready` and review Runtime Logs after every production promotion.
4. Alert externally when readiness is non-200 for two consecutive probes,
   `status` is repeatedly `bounded` or `deadline`, or an indexer request is 5xx.
   A single 202 `busy` is normal coalescing; sustained busy responses indicate
   lease contention or runs longer than the wake-up interval.
5. After a deployment reaches READY, exercise liveness, readiness, board,
   token-detail, authenticated indexer, and pin-cleanup paths, then scan the first hour of
   runtime errors before considering the release stable.

Incident actions:

- **Indexer stale or RPC-throttled:** keep launches disabled and market mode out
  of `live`; inspect cursor/RPC errors, restore provider capacity, then replay
  from the stored cursor. Never advance the cursor manually.
- **Reorg beyond the configured lookback:** stop ingestion, increase the audit
  window deliberately, locate an RPC-confirmed stored ancestor, run the exact
  rollback helper, and replay. Never guess an ancestor.
- **Neon degraded:** keep chain mutations disabled, leave the API fail-closed,
  and rebuild the disposable read model from the deployment block if recovery
  is not trustworthy.
- **Redis degraded:** mutation, cleanup, and indexer lease acquisition fail
  closed in production. Restore Redis rather than bypassing rate limits,
  nonces, or leases.
- **IPFS/Pinata degraded:** set `IPFS_PINNING_ENABLED=false`; already-pinned
  `ipfs://` metadata remains valid while new uploads stop.
- **Active abuse:** first tighten the already-observed route-specific WAF rule;
  the project owner may enable Vercel Attack Mode interactively if necessary.

## Release sequence

1. Complete Vercel two-factor verification, apply the reviewed migration to an
   isolated Preview Neon branch, and record its migration-ledger digest.
2. Exercise repository ingest/rollback/replay, retry/concurrency, pagination,
   query plans, indexer staleness, and market-read readiness with isolated
   Preview fixtures. Include holder-balance projection insert/replay/rollback,
   original/current-creator wallet portfolios, stale-watermark short circuit,
   both IP and IP-wallet Upstash limits on `POST /api/holdings`, and global
   leader publication where a launch outside the newest page wins the
   trailing-24-hour ranking. Prove a canonical rollback removes the leader
   snapshot from the database before replay, then verify the prior public
   response ages out within its bounded 10-second CDN TTL plus 20-second stale
   window. Capture
   `EXPLAIN (ANALYZE, BUFFERS)` at representative volume; the disposable
   PostgreSQL test proves correctness and index eligibility, not production
   latency. Canonical backfill cannot begin before contracts exist.
3. Exercise image and metadata pinning in Preview with separate abuse
   protection enabled. Prove the completed `ipfs_promotions` row is replay-safe,
   both exact on-chain URIs render, and a mismatched/direct-factory CID falls
   back to initials without a Pinata request; then return the pinning kill
   switch to `false`.
4. Apply the exact reviewed migration digest to Production only after Preview
   rehearsal passes. Keep `INDEXER_ENABLED=false` and
   `LAYPIPE_MARKET_MODE=fixture` in Production.
5. Complete the immutable pre-deployment candidate: contract tests,
   source-fidelity checks, deterministic ABI/artifact hashes, live
   preflights, the EIP-1153 runtime gate, and a no-broadcast deployment
   simulation.
6. Complete an independent audit and resolve every finding.
7. Fund the deployment address with testnet gas, broadcast Base Sepolia, and
   test creator-mode launch, exact approval, buy, sell, fee sweep, and revenue
   routing end to end. Verify the self-burn launch config remains disabled;
   do not exercise or enable the release-blocked self-burn execution path.
8. Re-run the release suite, deploy Robinhood contracts with launches disabled,
   verify source, record the complete post-deployment manifest including the
   earliest watched-contract receipt block, and transfer ownership to the Safe.
9. Backfill isolated Preview from that block, run finalized reconciliation,
   and verify live market reads. Then start the Production indexer and repeat
   reconciliation before any launch enablement.
10. Stage log-only WAF rules, deploy the Vercel application with addresses
    configured, run browser/mobile/API verification and the first-hour runtime
    error scan. Enable launches in a separate Safe transaction only after the
    market-read, mutation-flow, and reconciliation gates remain green. The
    exact-approval buy/sell and creator positions/claims paths are internally
    implemented, but still require the independent contract review, real
    browser/hardware-wallet rehearsal, and deployed-manifest E2E evidence.
    Keeper/reward eligibility and operator automation remain incomplete. Until
    every required mutation and keeper gate is proven, the public release must
    remain a disabled launcher plus read-only Board.

Rollback means disabling launch configuration and frontend mutation controls;
existing permanent pools cannot be removed or migrated by the current design.
