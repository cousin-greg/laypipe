# LayPipe production runbook

This file is the release gate for `laypipe.fun`. Chain state is authoritative;
Postgres is a rebuildable read model. No launch or trading control should be
enabled until every required contract address is configured and verified.

## Accounts and resources Greg must provide

1. **Vercel / Neon** — attach Neon Postgres to the `laypipe` project in Greg's
   Vercel team. Scope the production database to Production only and create a
   separate Neon branch or resource for Preview and Development.
2. **Pinata** — create a public-IPFS project and provide a server-only JWT plus
   its dedicated gateway base URL. The token-art upload endpoint must never
   receive this credential in the browser.
3. **Alchemy** — create Robinhood Chain Mainnet HTTP and WebSocket endpoints
   and an authenticated webhook. HTTP backfill plus webhooks is the primary
   ingestion path; WebSocket is an optional operational fallback. Public RPC
   is not production indexing infrastructure.
4. **Rate limiting** — attach an Upstash Redis resource for wallet/IP upload
   throttles and bounded indexer triggers.
5. **Protocol control** — provide separate Safe addresses for final owner,
   treasury, and operations. Do not use the deployment EOA as the permanent
   administrator or revenue destination.
6. **Economic sign-off** — approve supply, target starting FDV in PIPEDOG,
   launch fee, per-call routing and self-burn caps, keeper bounties, and the
   exact platform revenue split.
7. **Independent audit** — complete an external review before any deployment
   transaction is broadcast, including a public testnet deployment.

Copy `.env.example` to an ignored `.env.local` for local work. Put production
values in Vercel's encrypted environment settings. Never place database,
pinning, webhook, Redis, or wallet secrets in a `NEXT_PUBLIC_` variable.
Production and Preview must use different database, Redis, cron, webhook, and
pinning credentials. Mark every server-only credential as Sensitive in Vercel.
Restrict the Pinata key to only the file and JSON pinning permissions this app
uses. Database clients must initialize lazily so an intentionally unconfigured
Preview build fails at request time rather than during `next build`.

Public contract-address variables are the canonical address configuration for
both the browser and indexer. Server code must validate every address and the
hardcoded chain ID (`4663`) at startup instead of maintaining duplicate env
aliases that can drift.

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

## Artwork and metadata flow

The browser sends a PNG, JPEG, or WebP plus launch fields to the same-origin
pin endpoint. The server must authenticate a wallet challenge, rate-limit by
wallet and IP, enforce a 5 MB cap, inspect the actual file signature, decode
and re-encode the image, remove embedded metadata, and reject SVG.

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

The server parses returned CIDs with a multiformats implementation; browser
regex checks are only an early error message. Non-zero first buys remain
disabled until the application can derive a deterministic on-chain quote and
apply user-selected slippage instead of asking users to guess a minimum.

## Release sequence

1. Provision isolated Production and Preview resources.
2. Apply reviewed database migrations and backfill from a pinned deployment
   block.
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
