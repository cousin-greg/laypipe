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
- [x] Production Upstash is attached for nonce replay and rate-limit state.
- [-] Preview has no Redis resource, so upload and mutation routes fail closed.
- [x] `LAYPIPE_MARKET_MODE=fixture` and `IPFS_PINNING_ENABLED=false` are the
  deployed defaults.
- [-] `INDEXER_ENABLED=false`; no scheduler or Alchemy webhook is active.
- [-] No LayPipe contract has been broadcast to Base Sepolia or Robinhood.
- [-] Self-burn launch configuration remains contract-disabled.

## Greg: accounts, credentials, and decisions

Do not paste credentials into chat, GitHub, or any `NEXT_PUBLIC_` variable. Add
server credentials directly to the named Vercel environment or an ignored
local `.env` file.

- [ ] In GitHub branch protection for `main`, require both `Release gates`
  checks (`Application and data` and `Protocol local invariants`) before merge.

### 1. Finish Neon Preview setup

- [ ] Enter the six-digit authenticator code in Vercel's open Neon Query flow.
- [ ] Confirm the selected target is an isolated **Preview** branch, not the
  Production branch.
- [ ] Allow the reviewed migration in `db/migrations/` to run.
- [ ] Keep `LAYPIPE_MARKET_MODE=fixture` until migration, backfill, and health
  evidence are all green.

No database password or connection string needs to be sent to Codex; Vercel's
integration injects `DATABASE_URL` server-side.

### 2. Create Pinata credentials

- [ ] Provision a separate Preview-only Upstash database and attach its
  server-only URL/token as Sensitive Preview variables. Never reuse Production
  nonce, lease, or rate-limit state.
- [ ] Create separate Preview and Production Pinata projects/keys.
- [ ] Limit each key to the file upload/list/delete and JSON pinning permissions
  used by LayPipe; do not grant account administration.
- [ ] Add `PINATA_JWT` as a Sensitive, server-only Vercel variable.
- [ ] Add the dedicated HTTPS gateway origin as `IPFS_GATEWAY_BASE_URL`.
- [ ] Confirm the Preview/Production runtime role can insert and select only
  the immutable `ipfs_promotions` registry needed by the pin and read routes.
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
- [ ] Optionally add `ROBINHOOD_RPC_WS_URL` as an operational fallback.
- [ ] Create a dedicated authenticated Alchemy webhook and add its secret as
  `ALCHEMY_WEBHOOK_SIGNING_KEY`.
- [ ] Create separate Preview and Production `CRON_SECRET` values and Alchemy
  webhook/signing-key pairs with explicit Vercel environment scopes. A shared
  read-only RPC endpoint is acceptable only if its quota is sized and monitored.
- [ ] Confirm quotas can sustain finalized blocks faster than Robinhood
  produces them with ten-block `eth_getLogs` windows.

The archive endpoint is required to execute the currently blocked historical
CREATE2/factory integration suite. A public RPC failure is not a passing test.

### 4. Choose control and revenue addresses

- [ ] Create or select separate Safe addresses for `FINAL_OWNER`,
  `TREASURY_WALLET`, and `OPERATIONS_WALLET`.
- [ ] Decide whether factory upgrades require an on-chain timelock and guardian
  pause in addition to the existing launch-pause code gate.
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

- [ ] Apply the migration to the isolated Neon Preview branch twice and verify
  idempotence/hash-drift rejection.
- [ ] Run canonical ingest, rollback, replay, cursor-CAS, and live market-query
  integration against Preview Neon.
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
  and no-broadcast deployment simulation.
- [ ] Confirm the deploy script stages creator-fee config enabled, self-burn
  config disabled, global launches disabled, and pending Safe ownership.
- [ ] Record the pre-deployment source/compiler/dependency/ABI/artifact and
  approved-economics hashes. Receipt blocks, deployed addresses/codehashes, and
  final reconciliation belong to the post-deployment verification gate below.

## Broadcast gates

No step below is authorized merely because the earlier checklist is green.
Greg must explicitly authorize each broadcast after the independent audit.

### Base Sepolia

- [ ] Fund the throwaway Base Sepolia deployer with test ETH only.
- [ ] Re-run the Base preflight and no-broadcast simulation at the intended
  head.
- [ ] With explicit authorization, deploy the test-only mock-PIPEDOG stack with
  launches disabled and self-burn config disabled.
- [ ] Accept ownership from the reviewed Safe/test owners before enabling the
  creator-fee rehearsal config.
- [ ] Test exact approval, creator-mode launch, buy, sell, fee sweep, creator
   claim, deferred platform payout/retry, and 25/25/50 protocol routing.
- [ ] For buy and sell, prove ArbSys/native-chain deadline expiry, last-moment
  account/chain/head drift rejection, indeterminate-send retry locking, exact
  calldata/value receipt binding, canonical confirmation, and post-clear
  allowance rereads.
- [ ] Verify self-burn remains disabled; do not enable it merely for the smoke
  test.

### Robinhood production

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
