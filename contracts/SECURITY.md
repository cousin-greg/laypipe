# Security and known limitations

## Deployment status

These contracts are unaudited and not deployed. Passing unit, invariant, or
fork tests and completing a no-broadcast simulation are necessary evidence,
not substitutes for an independent audit or authorization to deploy.

## Curve economics are not calibrated

The start tick and all PIPEDOG-denominated limits require explicit economic
review. No production values are supplied in `.env.example`.

For equal-decimal PIPEDOG/token pools, tick `204200` implies roughly
737,649,301 launched tokens per PIPEDOG. At a 1,000,000,000-token supply that
is an initial FDV of about 1.356 PIPEDOG. It is retained only as a regression
warning and must not be treated as a default.

`scripts/calibrate-curve.mjs` aligns a target to tick spacing, but it does not
model executable depth, price impact, fee effects, MEV, demand, or market
quality. A separate economic simulation and review are required.

## Permanent one-sided pools

Each launch receives one token-only v4 position. The non-upgradeable hook
rejects later additions, all removals, and donations. There is no graduation
state machine.

This simplifies custody and prevents liquidity extraction, but it also means:

- pool depth cannot be topped up or repaired;
- a bad start tick or supply choice is permanent for that launch;
- an exhausted or illiquid curve cannot be migrated by the current protocol;
- a future factory upgrade cannot alter existing hook-enforced liquidity.

Do not describe these launches as graduating to another venue. Adding
graduation requires a separately designed and audited state machine.

The locked LayPipe pool is permanent, not exclusive. A launched token is a
plain transferable ERC-20, so any holder can seed another v3, v4, or external
DEX pool without the LayPipe hook. Those venues do not feed the protocol's
creator, platform, or self-burn lanes and can fragment liquidity. Fee and burn
forecasts must account for this leakage; preventing it would require a
materially different, separately audited token-level venue-control design.

## PIPEDOG assumptions

The protocol pins canonical PIPEDOG on Robinhood Chain:

`0x5Cb6F181081301b44905F3ae15419112ecaBd8A6`

The preflight checks deployed bytecode and metadata. Runtime transfers assume
an exact-transfer, non-rebasing, 18-decimal ERC-20. Balance-delta guards reject
short receipts and unexpected transfer behavior.

PIPEDOG does not expose permit in the supported flow. Users must make a
separate exact approval for the factory or swap router. Those entrypoints
reject allowances above or below the requested amount and successful calls
consume the allowance to zero. Never request an unlimited approval to the
upgradeable factory. A malicious future factory upgrade could spend any
allowance still granted to its proxy address.

Native ETH and WETH are not operational quote or payment assets. Native
recovery functions exist only because value can be force-sent to a contract.

## Robinhood L2 block numbers

Robinhood is an Arbitrum Orbit chain where Solidity `block.number` is a
periodically updated Ethereum L1 estimate, not the current Robinhood L2 block.
The active token checkpoints, `launchBlock`, revenue routing gates, and
self-burn gate therefore read `arbBlockNumber()` from ArbSys precompile `0x64`
on chain ID 4663 and fail closed if that call is unavailable. Using the L1
estimate would make per-block behavior unexpectedly coarse and checkpoint ids
incorrect for Robinhood activity.

The non-Robinhood `block.number` branch exists only for isolated rehearsals,
including Base Sepolia, and is guarded by separate deployment preflights. The
quarantined dividend artifact still contains its historical clock assumptions;
it is not deployed or part of the canonical ABI surface.

## Token ordering and vanity mining

PIPEDOG must be `currency0`. A valid launched token address must both end in
`0xcc` and be numerically greater than the PIPEDOG address. The factory checks
both conditions after deterministic address prediction, and the hook and swap
router independently check pool ordering.

Off-chain salt miners must enforce both constraints. Finding the suffix alone
is insufficient.

## Slippage, partial fills, and MEV

Factory first buys and public router swaps take caller-defined minimum output.
The hook rejects quote-specified partial fills so fees are not charged against
PIPEDOG that did not trade. Poor minimum-output settings still expose users to
ordinary price movement and sandwiching.

Exact-output fees use full-precision ceiling gross-up so the configured rate
is measured against total PIPEDOG flow. Without that gross-up, a nominal 1%
fee on a net amount would produce an effective gross rate of about 0.9901%.

Self-burns currently have no independent on-chain minimum-output reference.
They are permissionless, publicly visible market orders that can be
manipulated and sandwiched: an attacker can move the price before the
protocol-funded buy and unwind afterward. The immutable PIPEDOG-per-call cap
and one-call-per-pool-per-block rule only bound each loss; they do not make the
execution safe. Keep the self-burn launch configuration disabled until an
independently audited TWAP/oracle or otherwise bounded execution design is in
place. A caller-supplied minimum alone is not protection when the caller is
permissionless.

The platform revenue router performs no market swap. Its sequestration and
treasury calls transfer PIPEDOG directly, so the old WETH/PIPEDOG buyback MEV
model does not apply.

## Sequestration is not a supply burn

The platform lane sends PIPEDOG directly to
`0x000000000000000000000000000000000000dEaD`. This removes tokens from
practical circulation but leaves ERC-20 `totalSupply` unchanged. Interfaces,
events, analytics, and marketing must report sink balance or PIPEDOG
sequestered, not a reduction in total supply.

This differs from self-burn mode. A self-burn pool buys its launched token and
calls that token's real `burn()`, reducing the launched token's `totalSupply`.

## Permissionless maintenance

Hook fees remain PoolManager claims until `sweep(poolId)` is called. Fee sweeps
pay no bounty, so dormant pools need protocol-funded or creator-motivated
automation.

Revenue sequestration and treasury routing pay a configured PIPEDOG bounty
from their respective processed lanes. Self-burns pay their bounty from the
bounded PIPEDOG fuel chunk. Caps, once-per-block gates, and bounties are
deployment parameters and need operational review.

Hook sweep and creator claim transfers are atomic exact PIPEDOG transfers.
There is no deferred platform payout tab. A broken or incompatible treasury
destination causes the sweep to revert rather than parking the platform share.

## Administrative trust

- **Factory owner:** may upgrade the launcher for future calls, change launch
  fee and config enablement, rotate compatible infrastructure while launches
  are paused, and recover assets held by the factory. Factory-held PIPEDOG goes
  to the protocol treasury; unrelated ERC-20s and force-sent native currency
  go to the owner. Recovery cannot reach PoolManager liquidity, hook claims,
  creator tabs, allowances, or user balances.
- **Hook owner:** may rotate only the platform treasury destination. The hook
  is not upgradeable. Creator balances and creator-stream ownership remain
  creator-controlled.
- **Revenue-router owner:** may pause the sequestration and treasury lanes,
  rotate treasury/operations destinations, change their per-call caps, recover
  unrelated assets, and migrate all router-held PIPEDOG to a successor.
- **Self-burner and swap router:** have no owner or withdrawal path for
  operational assets. Their protocol bindings and bounty/cap parameters are
  immutable.
- **Launched token:** is an ownerless clone after initialization.

The 25/25/50 constants govern normal revenue allocation, but owner migration
can move all remaining PIPEDOG to a successor. Treat the split as a trusted
operating policy, not an irrevocable custody guarantee.

Hook rotation automatically pauses launches and clears the old
hook-bound self-burner. Treasury changes require launch to be paused and the
factory and hook destinations to agree before re-enabling.

The deployment script uses two-step ownership and leaves launch disabled.
Until `FINAL_OWNER` accepts, the deployment signer remains the current owner.
Do not fund or enable the system before ownership acceptance is complete.

## Dividend artifact is quarantined

`LaypipeDividendDistributor.sol` is not compatible with the canonical PIPEDOG
quote stack and remains only as source-comparison research. The factory does
not import or store a distributor, `dividendDistributor()` is always zero,
`dividendLaunchEnabled()` is always false, and enabling it reverts.

The deployment script never deploys it, and canonical ABI generation removes
its stale ABI. It is not a dormant feature flag and must not be exposed in a
frontend. A future dividend design requires a new audited implementation,
complete-holder or proof-based accounting, and explicit PIPEDOG semantics.

## Source-provenance boundary

The LetsCash hook, token, dividend distributor, and an earlier self-burner have
verified MIT source. The current LetsCash factory, self-burner, and revenue
splitter were unverified when captured.

`PipedogHook` and `LaypipeSelfBurner` are reviewed derivatives, not
source-identical copies: their native-value assumptions were replaced with
canonical PIPEDOG claims, settlement, and exact-transfer checks, among other
documented deltas. `LaypipeToken` also differs from its mechanical baseline by
using the Robinhood ArbSys L2 block clock for checkpoints and `launchBlock`.
`LaypipeFactory`, `LaypipeSwapRouter`, and `PipedogRevenueRouter` are clean-room
LayPipe implementations.

Run the reference fetch, source-fidelity check, full build/test suite, live
preflight, ABI generation, and no-broadcast deployment simulation immediately
before an audit handoff.

The Robinhood preflight pins canonical PIPEDOG, Uniswap v4 PoolManager, and
the deterministic CREATE2 deployer runtime codehashes, exercises the
PoolManager interface, and requires a valid ArbSys L2 block-number response.
Any dependency-runtime change fails closed pending explicit review.

## Secrets and broadcasts

Keep the deployment key only in ignored local configuration. Never commit or
print `.env`, deployment keys, keystores, mnemonics, Safe signing material, or
broadcast/cache artifacts.

Never add `--broadcast` without explicit authorization and an independent
audit.
