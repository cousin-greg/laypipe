# LayPipe production runbook

This file is the release gate for `laypipe.fun`. Chain state is authoritative;
Postgres is a rebuildable read model. No launch or trading control should be
enabled until every required contract address is configured and verified.

## Current Vercel resource status

- The `laypipe-production` Neon integration is attached to Production and
  Preview. Preview database branching is enabled, so preview migrations and
  data do not touch the production branch.
- The `laypipe-production-rate-limits` Upstash database is attached to
  Production only. Preview upload/mutation routes intentionally fail closed
  instead of sharing the production nonce and rate-limit store.
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
  mode can be enabled.
- No launch configuration is approved yet. Supply, aligned start tick,
  executable curve depth, price impact, caps, bounties, and launch fee require
  PIPEDOG-denominated simulation and written sign-off. The historical tick
  `204200` is explicitly not a production default.
- Put factory ownership behind a Safe plus a reviewed timelock/guardian plan.
  Exact approvals reduce exposure, but an immediately upgradeable spender can
  still exploit the allowance window if its owner is compromised. The wallet
  must verify the pinned implementation immediately before both approval and
  launch.
- Decide whether the revenue router's owner migration power is acceptable as
  disclosed policy or must be timelocked/limited before launch. The normal
  25/25/50 routing split is not irrevocable while that migration path exists.
- Prove EIP-1153 transient-storage support on the exact Robinhood Chain
  runtime before deployment. The factory currently uses transient reentrancy
  protection, while a Cancun-configured Foundry simulation can mask a target
  chain that does not execute `TLOAD`/`TSTORE`. Use a minimal on-chain probe
  after audit authorization or replace it with reviewed upgrade-safe storage
  protection and validate the storage layout.

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
mutation routes use `no-store`. Indexer work is bounded by block batch, guarded
by `CRON_SECRET`, idempotent, and safe to retry.

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
`TokenParams.metadataURI`. Persist both CIDs in Postgres. A gateway URL is a
delivery convenience; `ipfs://` is the durable identity.

The pin route returns `{ image, metadata, metadataDocument }`. Before requesting
any allowance, the browser rebuilds the expected document from the reviewed
form and returned image URI and requires an exact deep match with
`metadataDocument`. Any missing field, URI/CID mismatch, or metadata mismatch
fails closed before a wallet transaction.

Upstash rate-limits IPs and wallets and consumes every challenge nonce once.
`/api/ipfs/cleanup`, authorized by `CRON_SECRET`, deletes only validated
`laypipe_stage=true` files older than one hour, with bounded pagination and a
100-file deletion cap. Choose a recurring scheduler before enabling uploads;
the Hobby-plan daily cron ceiling is not sufficient for sustained heavy launch
traffic. Permanent artwork and metadata pins are never selected for cleanup.

The server parses returned CIDs with a multiformats implementation; browser
regex checks are only an early error message. Non-zero first buys remain
disabled until the application can derive a deterministic on-chain quote and
apply user-selected slippage instead of asking users to guess a minimum.

## Release sequence

1. Complete Vercel two-factor verification and apply the reviewed database
   migration to the production Neon branch.
2. Apply the same migration to an isolated Preview branch, then backfill from
   a pinned deployment block.
3. Exercise image and metadata pinning with abuse protection enabled.
4. Complete contract tests, source-fidelity checks, ABI generation, live
   preflights, and a no-broadcast deployment simulation.
5. Complete an independent audit and resolve every finding.
6. Fund the deployment address with testnet gas, broadcast Base Sepolia, and
   test launch, exact approval, buy, sell, fee sweep, self-burn, and revenue
   routing end to end.
7. Re-run the release suite, deploy Robinhood contracts with launch disabled,
   verify source, record and pin the proxy plus implementation identity used by
   the browser preflight, and transfer ownership to the Safe.
8. Start the production indexer from the deployment block and compare indexed
   totals against direct RPC reads.
9. Deploy the Vercel application with addresses configured, run browser and
   mobile verification, then enable launches in a separate Safe transaction.

Rollback means disabling launch configuration and frontend mutation controls;
existing permanent pools cannot be removed or migrated by the current design.
