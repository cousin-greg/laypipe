# LayPipe external-audit handoff

This document defines the minimum review boundary for a LayPipe release
candidate. It is not an audit report, approval, or authorization to deploy.
The auditor and LayPipe release owner must replace every pre-deployment
candidate placeholder below with immutable evidence before review begins.
Receipt blocks, deployed addresses/codehashes, and on-chain reconciliation are
separate post-deployment verification evidence and cannot precede the audit.

## Candidate identity

- Git commit or signed tag: **required**
- Solidity compiler: `0.8.28`
- EVM target: `cancun`
- Optimizer: enabled, 800 runs, via IR
- Generated ABI bundle SHA-256: **required**
- Compiled artifact bundle SHA-256: **required**
- Approved curve-review file and config hash: **required**
- Target chain: Robinhood Chain, chain ID `4663`
- Canonical PIPEDOG: `0x5Cb6F181081301b44905F3ae15419112ecaBd8A6`
- Canonical Uniswap v4 PoolManager and runtime codehash: **required**
- Planned indexer start-block rule: **earliest receipt block across every watched
  contract deployment transaction**, not the proxy or final configuration receipt
- Post-deployment read-only reconciliation block/report: **required before
  launch enablement, not before the pre-deployment audit**

Do not review a moving branch. Any source, dependency, compiler, ABI, artifact,
deployment-script, or approved-economics change creates a new candidate.

## Canonical source scope

The production protocol surface is:

- `src/LaypipeFactory.sol`
- `src/LaypipeToken.sol`
- `src/PipedogHook.sol`
- `src/LaypipeSwapRouter.sol`
- `src/LaypipeSelfBurner.sol`
- `src/PipedogRevenueRouter.sol`
- `src/PipedogProtocolConfig.sol`
- `src/lib/ChainBlockNumber.sol`
- `src/lib/CurrencySettler.sol`
- `src/lib/CurveEconomics.sol`
- `src/lib/HookMiner.sol`
- `src/lib/LiquidityAmounts.sol`
- `script/DeployLaypipe.s.sol`
- `script/PreflightRobinhood.s.sol`
- `script/SweepHookFees.s.sol`

The first authorized testnet broadcast path is also in audit scope:

- `script/BaseSepoliaConfig.sol`
- `script/PreflightBaseSepolia.s.sol`
- `script/DeployLaypipeBaseSepolia.s.sol`
- `script/mocks/MockPipedogBaseSepolia.sol`

`src/LaypipeDividendDistributor.sol` is deliberately quarantined and excluded
from the generated production ABI and deployment scripts. The audit must still
confirm that no canonical factory/config/deployment path can select or deploy
that artifact.

The Base Sepolia mock token and deployment path are rehearsal-only. They are
in scope only to confirm isolation from Robinhood production configuration and
to validate the deployment/ownership runbook; mock-token economics are not a
production security assumption.

## Pinned external dependencies

The exact revisions are authoritative in `scripts/install-deps.ps1`:

- Foundry forge-std `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b`
- OpenZeppelin Contracts `2d59c17d9f9ffac7ae721f8eb29aa9544daf558f`
- OpenZeppelin Contracts Upgradeable `c2462606bc1322a80d742159b2ff2728b5f76ecd`
- OpenZeppelin Uniswap hooks `acbd604c409a827f7f98c9517236da860c4fca1a`
- Uniswap v3 core `e3589b192d0be27e100cd0daaf6c97204fdb1899`
- Uniswap v4 core `a7cf038cd568801a79a9b4cf92cd5b52c95c8585`

The review must cover the imported dependency paths actually reachable from
canonical contracts, not only LayPipe-authored lines.

## Required invariants and threat models

The review must independently validate at least these properties:

1. **PIPEDOG-only quote path.** Launch fees, pool settlement, hook fees,
   creator claims, and protocol routing use canonical PIPEDOG. ETH is gas only;
   no production launch path silently substitutes native ETH or WETH.
2. **Exact-transfer accounting.** The design assumes a vanilla 18-decimal ERC-20
   with exact transfers and no permit, tax, rebase, callback, or blacklist.
   Every allowance, settlement delta, refund, and balance-difference check must
   conserve PIPEDOG under that explicit model and fail safely otherwise.
3. **Permanent canonical pool.** Each launch creates one initialized one-sided
   Uniswap v4 pool. The hook must reject unauthorized initialization, donation,
   liquidity addition/removal, and settlement paths that bypass accounting.
   Alternate external DEX pools remain possible and must not be represented as
   preventable by the canonical hook.
4. **Swap quadrants and partial fills.** Exact-input and exact-output buy/sell
   paths must apply the 1% fee to the intended PIPEDOG amount, settle all four
   balance-delta quadrants correctly, enforce limits, and reject unsafe partial
   fills or signed/unsigned truncation. Public-router buy and sell intents must
   both bind and enforce their canonical-chain block deadline, including the
   Robinhood ArbSys branch and its fail-closed behavior.
5. **Launch atomicity and residual approval.** Token clone identity, metadata,
   supply seeding, pool key/config selection, launch-fee collection, optional
   first-buy state, and emitted identities must either all bind to one reviewed
   launch or fully revert. Because approval is a separate transaction, a failed
   launch can leave the exact allowance in place; the wallet must detect that
   state, block blind retries, and offer a safe revoke path.
6. **Upgrade and ownership safety.** UUPS initialization, authorization,
   storage layout, EIP-1967 implementation identity, two-step ownership, and
   launch-pause upgrade gate must resist pending-owner, stale-manifest,
   malicious-implementation, and allowance-window attacks. Review the Safe,
   timelock, and guardian operating plan together with the code.
7. **Fee liveness.** Pool claims, creator credit, best-effort platform payout,
   deferred `platformTab`, and permissionless retry must conserve all value.
   A reverting creator, treasury, router, PoolManager redemption, or transfer
   must not silently lose or duplicate credit.
8. **Revenue policy and migration.** Normal 25/25/50 PIPEDOG allocation,
   per-call caps, bounty deductions, dead-address sequestration, pause behavior,
   and same-PIPEDOG successor migration must be exact. The owner migration power
   is trusted policy rather than an irrevocable split and must be assessed as
   such.
9. **Robinhood runtime assumptions.** Active block guards use ArbSys rather than
   Solidity's parent-chain `block.number`. Transient-storage guards require
   EIP-1153. Both must fail closed on unsupported runtimes and be re-proved on
   the exact release RPC/head.
10. **Curve immutability and exhaustion.** Approved supply, tick spacing, start
    tick, initial price/depth, rounding, fee-inclusive impact, reversal, dust,
    and exhaustion boundaries must match exact on-chain math. No historical
    ETH-denominated value is an acceptable default.

## Known release blockers and disclosed limitations

- The permissionless self-burn function executes a visible protocol-funded
  market order without an attacker-independent oracle/TWAP bound. Its launch
  config must remain disabled. A caller-provided minimum output alone does not
  protect a permissionless caller from choosing an exploitable value.
- Curve economics are intentionally unset until an approved, source-hashed
  PIPEDOG review passes `scripts/simulate-curve.mjs`.
- Canonical liquidity is permanent, but the token remains transferable and
  holders can create alternate pools that bypass the canonical hook fee.
- Factory upgrades and revenue migration retain administrator trust. Pauses,
  compatible-successor checks, exact approvals, and manifest verification
  reduce exposure but are not substitutes for a Safe/timelock policy.
- Platform fee sweeping is an operational keeper dependency. Deferred payout
  preserves accounting but does not guarantee prompt routing.
- Dead-address sequestration removes PIPEDOG from usable circulation but does
  not reduce the token's ERC-20 `totalSupply`.
- The public Robinhood RPC has previously failed historical absent-account
  reads used by CREATE2 integration tests. Final review evidence requires an
  archive-capable provider rather than treating skipped fork tests as passing.

See `SECURITY.md`, `CURVE_REVIEW.md`, and `KEEPERS.md` for the full current
limitations and operating assumptions. Any contradiction must be resolved in
favor of the more conservative release behavior.

## Reproduction gates

From a clean dependency install, the auditor should independently run:

```powershell
.\scripts\install-deps.ps1
forge clean
forge build
forge build --sizes
forge test -vv
node scripts\check-source-fidelity.mjs
node scripts\generate-abis.mjs
git diff --exit-code -- abi
node --test scripts\release-hashes.test.mjs
node scripts\release-hashes.mjs
node scripts\check-robinhood-eip1153.mjs
forge script script/PreflightRobinhood.s.sol:PreflightRobinhood --rpc-url robinhood -vv
forge script script/DeployLaypipe.s.sol:DeployLaypipe --rpc-url robinhood -vvv
forge script script/PreflightBaseSepolia.s.sol:PreflightBaseSepolia --rpc-url base_sepolia -vv
forge script script/DeployLaypipeBaseSepolia.s.sol:DeployLaypipeBaseSepolia --rpc-url base_sepolia -vvv
node scripts\simulate-curve.mjs --review <approved-curve-review.json>
```

The deployment script command is a simulation only. No audit command or report
authorizes adding `--broadcast`.

Copy the two aggregate values and all six per-contract ABI/artifact hashes from
`release-hashes.mjs` into the retained candidate evidence. Then rerun the same
code in strict mode with the recorded aggregate values (or the two matching
audited-manifest environment variables):

```powershell
node scripts\release-hashes.mjs --check `
  --abi-bundle-sha256 <recorded ABI bundle SHA-256> `
  --artifact-bundle-sha256 <recorded artifact bundle SHA-256>
```

This projection covers the six canonical ABI arrays and their compiler,
creation/runtime bytecode templates, and immutable-patch ranges. It excludes
filesystem paths, timestamps, source maps, Foundry artifact IDs, ASTs, and raw
metadata formatting. Deployment-specific constructor/immutable values, the
factory proxy, and live runtime codehashes remain separately required in the
audited deployment manifest. Storage layout, build-info, and deployment scripts
remain independently reviewed, commit-bound inputs and are not covered by the
two aggregate hashes.

The audited compiler configuration uses `bytecode_hash = "none"` and retains
the CBOR compiler marker. This removes machine/source-metadata digests before
bytecode generation; no post-build byte stripping is permitted. The artifact
bundle therefore continues to bind exact creation and runtime templates.

The final report should include manual findings, static-analysis output,
fuzz/invariant methodology, fork block/RPC evidence, dependency review scope,
economic-model review scope, unresolved assumptions, and confirmation that all
reported fixes were re-reviewed on the immutable candidate.

## Release acceptance

LayPipe may record the audit gate as complete only when:

- the final report names the exact candidate commit and dependency revisions;
- all critical/high findings are resolved and retested;
- every accepted lower-severity risk is documented in `SECURITY.md` and the
  production runbook;
- approved economics and deployment artifacts match the reviewed candidate;
- the external reviewer confirms remediation coverage in writing; and
- the release owner separately gives explicit deployment authorization.

After an audited and explicitly authorized deployment with launches disabled,
the owner must append the complete deployment manifest, earliest watched receipt
block, source verification, ownership acceptance, and a finalized zero-mismatch
reconciliation report. Any deployed code/config drift reopens audit review and
must never be papered over as an operator check.
