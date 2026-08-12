# LayPipe production launch checklist

This is the short operator checklist for taking `laypipe.fun` from its safe
fixture deployment to live launches. `PRODUCTION.md` contains the detailed
runbook and is authoritative when this checklist is abbreviated.

Legend: `[x]` verified, `[ ]` required, `[-]` deliberately disabled or waiting
on another gate.

## Current safe state

- [x] Vercel is the only deployment target; `laypipe.fun` and `www.laypipe.fun`
  are attached to the LayPipe project.
- [x] Vercel Preview builds the production-readiness branch with Node 24.
- [x] Neon is attached to Production and Preview with Preview branching.
- [-] The Neon schema is not applied. Vercel Query is waiting for Greg's 2FA.
- [x] The free `laypipe-production-rate-limits` Upstash database is Available
  and attached to the LayPipe project's Production environment only. Vercel
  shows masked `UPSTASH_REDIS_REST_KV_REST_API_URL` and
  `UPSTASH_REDIS_REST_KV_REST_API_TOKEN` variables; no secret values were
  copied out.
- [-] Production upload and mutation routes remain disabled until their
  nonce-replay, lease, and rate-limit behavior receives the checklist's
  fail-closed release smoke.
- [ ] Attach a separate Preview Redis resource before testing upload or
  mutation routes. Until then those routes must fail closed.
- [x] `LAYPIPE_MARKET_MODE=fixture` and `IPFS_PINNING_ENABLED=false` are the
  deployed defaults.
- [-] `INDEXER_ENABLED=false`; no scheduler or Alchemy webhook is active.
- [-] No LayPipe contract has been broadcast to Base Sepolia or Robinhood.
- [-] Self-burn launch configuration remains contract-disabled.

## Greg: accounts, credentials, and decisions

Do not paste credentials into chat, GitHub, or any `NEXT_PUBLIC_` variable. Add
server credentials directly to the named Vercel environment or an ignored
local `.env` file.

- [x] GitHub branch protection for `main` strictly requires both `Release
  gates` checks (`Application and data` and `Protocol local invariants`), with
  force pushes and branch deletion disabled.

### 1. Finish Neon Preview setup

- [ ] Enter the six-digit authenticator code in Vercel's open Neon Query flow.
- [ ] Confirm the selected target is an isolated **Preview** branch, not the
  Production branch.
- [ ] Allow the reviewed migration in `db/migrations/` to run.
- [ ] Create separate NOLOGIN read/write/service group roles. The service role's
  sole member must be the migration owner with ADMIN, INHERIT, and SET options;
  each rotatable
  read/write LOGIN must inherit exactly its one matching group. Run
  `npm run db:grant-runtime` as the migration owner,
  then verify the runtime credentials with the PostgreSQL privilege test.
- [ ] Keep `LAYPIPE_MARKET_MODE=fixture` until migration, backfill, and health
  evidence are all green.

No database password or connection string needs to be sent to Codex. Create
separate read/write runtime credentials on the same primary Preview branch,
apply grants with the operator-only migration credential, and add only
`DATABASE_READ_URL` and `DATABASE_WRITE_URL` to Vercel. Never add
`DATABASE_MIGRATION_URL` to Vercel.

### 2. Create Pinata credentials

- [ ] Provision a separate Preview-only Upstash database and attach its
  server-only URL/token as Sensitive Preview variables. Never reuse Production
  nonce, lease, or rate-limit state.
- [ ] Create separate Preview and Production Pinata projects/keys.
- [ ] Limit each key to the file upload/list/delete and JSON pinning permissions
  used by LayPipe; do not grant account administration.
- [ ] Add `PINATA_JWT` as a Sensitive, server-only Vercel variable.
- [ ] Add the dedicated HTTPS gateway origin as `IPFS_GATEWAY_BASE_URL`.
- [ ] Add separate server-only `MARKET_CURSOR_SECRET` and
  `WALLET_CHALLENGE_SECRET` values; read-only deployments require only the
  market cursor secret.
- [ ] Confirm the Preview/Production write role has only SELECT/INSERT/UPDATE
  on immutable `ipfs_promotions`; UPDATE is limited by the immutable trigger to
  identical `ON CONFLICT` retries.
- [ ] Configure and rehearse backup/restore for `ipfs_promotions`; chain replay
  alone intentionally cannot re-authorize artwork after registry loss.
- [ ] Keep `IPFS_PINNING_ENABLED=false` until the real stage, promote, verify,
  cleanup, replay, registry-idempotency, unapproved-CID fallback, and rate-limit
  tests pass in Preview.

### 3. Create RPC/indexing credentials

- [ ] Create an archive-capable Robinhood Chain Mainnet HTTPS endpoint and add
  it as server-only `ROBINHOOD_RPC_HTTP_URL`.
- [ ] Put the audit/release RPC in ignored `contracts/.env` as
  `ROBINHOOD_RPC_URL`; do not pass a private URL in the process list.
- [ ] Create a dedicated authenticated Alchemy webhook and add its secret as
  `ALCHEMY_WEBHOOK_SIGNING_KEY`.
- [ ] Create separate Preview and Production `CRON_SECRET` values and Alchemy
  webhook/signing-key pairs with explicit Vercel environment scopes. A shared
  read-only RPC endpoint is acceptable only if its quota is sized and monitored.
- [ ] Confirm quotas can sustain finalized blocks faster than Robinhood
  produces them with ten-block `eth_getLogs` windows.

The archive endpoint is required for 18 currently blocked historical tests:
all 17 CREATE2/factory integration bodies plus one Robinhood direct-routing
preflight test. The final full suite contains 77 tests; a public RPC failure is
not a passing test.

### 4. Choose control and revenue addresses

- [ ] Create or select separate Safe addresses for `FINAL_OWNER`,
  `TREASURY_WALLET`, and `OPERATIONS_WALLET`.
- [ ] Decide whether factory upgrades require an on-chain timelock and guardian
  pause in addition to the existing launch-pause code gate. Treat this as a
  release gate: a Safe can atomically batch pause, mutation, and re-enable calls,
  so the boolean check alone creates no allowance-revocation window.
- [ ] Decide whether the paused same-PIPEDOG revenue-router migration power is
  accepted policy or needs a timelock/stricter contract limit.
- [ ] Write the signer, quorum, key-loss, rotation, and incident-pause runbook.

The deployer EOA must not remain the final owner or a permanent revenue
destination.

### 5. Approve PIPEDOG economics

- [ ] Approve launch supply and target starting FDV in PIPEDOG.
- [ ] Approve tick spacing, aligned start tick, launch fee, executable depth,
  maximum all-in impact, reversal loss, dust, and exhaustion bounds.
- [ ] Approve sequester/treasury per-call caps and router keeper bounty.
- [ ] Keep self-burn caps/bounty recorded but the self-burn config disabled.
- [ ] Sign the source-hashed curve review consumed by
  `contracts/scripts/simulate-curve.mjs`.

Never copy the historical ETH-denominated start tick or promote Base rehearsal
values into Robinhood production.

### 6. Commission the independent audit

- [ ] Give the reviewer the immutable candidate and
  `contracts/AUDIT_HANDOFF.md`.
- [ ] Require the final report to name the exact commit, compiler, dependency
  revisions, ABI/artifact hashes, curve-review hash, RPC/fork evidence, and
  remediation commit.
- [ ] Resolve and re-review every critical/high finding.
- [ ] Document every accepted lower-severity risk in `contracts/SECURITY.md`.

Internal tests and Codex adversarial reviews are preparation, not an
independent audit.

## Operator: Preview rehearsal

- [ ] Configure a Vercel Deployment Protection automation bypass for the
  isolated Preview rehearsal and give only that bypass to the Alchemy webhook,
  scheduler, and uptime monitor. The current Preview redirects unauthenticated
  `/api/health`, `/api/ready`, and `/api/tokens` requests to Vercel SSO, so
  external-route rehearsal has not happened yet.
- [ ] Set Preview to `LAYPIPE_CONFIG_PROFILE=preview-indexer`, retain the
  Vercel build's secret-free `prebuild` output, and rehearse indexing while the
  Board remains fixture-only. Advance to `preview-readonly` only after backfill
  and readiness pass. Separately compare the Neon branch, Upstash database,
  Pinata project/gateway, cron secret, and webhook ID with Production because a
  static configuration check cannot prove resource separation.
- [ ] Apply the migration to the isolated Neon Preview branch twice and verify
  idempotence/hash-drift rejection.
- [ ] Run canonical ingest, rollback, replay, cursor-CAS, and live market-query
  integration against Preview Neon.
- [ ] At representative Preview volume, prove the once-per-minute global
  leader refresh uses the intended window index, can select a winner outside
  the newest page, and uses the same exact-cutoff baseline as Board/detail.
  Include the pre-cutoff, new-pool fallback, and all-negative cases. Prove the
  snapshot is deleted from the canonical read model immediately on rollback
  before replay. Confirm the public response stops serving the prior
  leader after its bounded 10-second CDN TTL plus 20-second stale window.
- [-] Canonical Robinhood backfill and `npm run db:reconcile` wait until the
  audited, explicitly authorized Robinhood deployment exists with launches
  disabled. Preview may rehearse schema, repository, rollback, query, and
  failure behavior with isolated fixtures before then.
- [ ] Exercise real Pinata image stage → normalized image pin → deterministic
  metadata pin → launch-form deep match → stale-stage cleanup.
- [ ] Verify invalid signatures, consumed nonces, replay, cross-wallet binding,
  oversized payloads/images, MIME spoofing, decompression limits, cross-origin
  requests, and Upstash/provider outages all fail closed.
- [ ] Stage Vercel Firewall rules in log-only mode for `/api/tokens` and
  `/token/*`, starting at 120 requests/minute/IP; review logs before publishing
  an enforcing 429 rule.
- [ ] Configure the external scheduler and signed webhook, then monitor
  the market-read `/api/ready` and alert on cursor lag, bounded/deadline exits, lease
  contention, reorg rollback, provider
  throttling, pin cleanup failure, and readiness failure.
- [ ] Switch **Preview only** to `LAYPIPE_MARKET_MODE=live` and verify Board,
  token detail, liveness/readiness, pagination, refresh, empty state, database outage, and
  reorg removal behavior with no fixture fallback.
- [ ] Run desktop/mobile browser verification in light and dark themes with no
  console errors, missing assets, horizontal overflow, or wallet controls
  enabled from an incomplete manifest.

## Pre-deployment contract release candidate and audit

- [ ] Run every command in `contracts/AUDIT_HANDOFF.md` against the immutable
  candidate and archive RPC.
- [ ] Run the full Foundry suite without exclusions or archive-related skips.
- [ ] Run source fidelity, ABI generation, ABI clean-diff, runtime size,
  Robinhood preflight, EIP-1153 semantic/control probe, approved curve review,
  approved deployment-input manifest/hash plus exact deploy-script runtime
  deep-match, and no-broadcast deployment simulation from an immutable clean
  checkout with no `FOUNDRY_*` or `DAPP_*` overrides.
- [ ] Confirm the deploy script stages creator-fee config enabled, self-burn
  config disabled, global launches disabled, and pending Safe ownership.
- [ ] Record the pre-deployment source/compiler/dependency/ABI/artifact,
  deploy-script runtime, and approved-economics hashes. Receipt blocks,
  deployed addresses/codehashes, and final reconciliation belong to the
  post-deployment verification gate below.

## Broadcast gates

No step below is authorized merely because the earlier checklist is green.
Greg must explicitly authorize each broadcast after the independent audit.

### Base Sepolia

- [ ] Fund the throwaway Base Sepolia deployer with test ETH only.
- [ ] Re-run the Base preflight and no-broadcast simulation at the intended
  head.
- [ ] With explicit authorization, deploy the test-only mock-PIPEDOG stack with
  launches disabled and self-burn config disabled.
- [ ] Accept ownership from the reviewed Safe/test owners before opening the
  global launch gate or allowing creator-mode rehearsal launches. The creator
  config may already be staged while that global gate remains closed.
- [ ] Test exact approval, creator-mode launch, buy, sell, fee sweep, creator
   claim, deferred platform payout/retry, and 25/25/50 protocol routing.
- [ ] For buy and sell, prove ArbSys/native-chain deadline expiry, last-moment
  account/chain/head drift rejection, indeterminate-send retry locking, exact
  calldata/value receipt binding, canonical confirmation, and post-clear
  allowance rereads.
- [ ] Retain timestamped Robinhood cadence evidence across multiple one-minute
  samples, including observed peak blocks per second. Recalibrate and rerun the
  trade safety suite if sustained cadence materially exceeds the 20-block-per-
  second stress assumption; prove acceptance at `deadlineBlock` and rejection
  at the next L2 block with a real wallet.
- [ ] Verify self-burn remains disabled; do not enable it merely for the smoke
  test.

### Robinhood production

- [ ] Before promotion, set
  `LAYPIPE_CONFIG_PROFILE=production-readonly` in the exact Production
  environment and retain the Vercel build's secret-free `prebuild` output.
  Set server-only `LAYPIPE_APP_SOURCE_COMMIT` to that application's exact Vercel
  Git SHA; do not replace the contract candidate's manifest source commit.
  Keep IPFS pinning and the public wallet-mutation switch false. A passing
  result is configuration evidence only; provider reachability, permissions,
  quotas, backups, alerts, and the independent audit remain separate gates.
- [ ] Re-run the entire release suite and compare outputs to the audited
  candidate.
- [ ] With explicit authorization, deploy with global launches disabled.
- [ ] Verify source and every runtime codehash; record the exact deployment
  manifest.
- [ ] Accept factory/hook/router ownership from the final Safe and confirm no
  pending owner remains.
- [ ] Backfill the isolated Preview database from the earliest watched-contract
  receipt block, run the finalized read-only reconciliation, and verify live
  Board/readiness behavior while launches remain disabled.
- [ ] Apply the already schema-rehearsed migration to Production Neon, start the
  canonical indexer at the earliest watched-contract receipt block, and
  reconcile against RPC.
- [ ] Deploy the manifest-configured Vercel build while mutation controls remain
  disabled; verify production browser/API/runtime evidence.
- [ ] Enable creator-mode launches in a separate Safe transaction only after
  the website and market indexer are proven live; the internally implemented
  exact-approval buy/sell and creator claim/position flows pass independent
  review plus real wallet E2E; and required keeper/reward automation and
  eligibility paths are implemented and tested. Until then, production scope
  is a disabled launcher plus read-only Board.

## Immediate rollback and incident actions

- [ ] Disable frontend launch/trade mutations without hiding read-only chain
  state.
- [ ] Close the factory's global launch gate before any upgrade or emergency
  action.
- [ ] Pause revenue routing when its destinations or accounting are in doubt.
- [ ] Keep chain logs immutable; roll the database back to the last common
  ancestor and deterministically replay.
- [ ] Rotate compromised server credentials and invalidate the affected
  Pinata/webhook/Redis/RPC key rather than reusing it.
- [ ] Publish the affected block range, contracts, and recovery evidence.

Existing canonical pools are permanent. Rollback can stop new launches and
frontend mutations; it cannot remove or migrate already initialized pools.
