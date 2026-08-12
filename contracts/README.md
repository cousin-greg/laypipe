# LayPipe protocol

Foundry implementation of the LayPipe launcher for Robinhood Chain. It adapts
the observable LetsCash launch model so canonical PIPEDOG is the quote,
payment, fee, and paired asset throughout the protocol.

Canonical PIPEDOG:

`0x5Cb6F181081301b44905F3ae15419112ecaBd8A6`

Status: active implementation work. The contracts are **unaudited and not
deployed**. A green local or fork test is not permission to broadcast. An
independent audit and explicit deployment authorization are required before
mainnet deployment. See [SECURITY.md](./SECURITY.md).

## Protocol shape

- Each launch creates an ownerless, fixed-supply `...cc` token clone.
- The token address is mined above the PIPEDOG address, making PIPEDOG
  `currency0` and the launched token `currency1` for every pool.
- The factory initializes a zero-LP-fee Uniswap v4 pool and seeds a single
  launched-token-only position.
- The non-upgradeable hook permanently rejects later liquidity additions,
  liquidity removal, and donations.
- There is no graduation threshold or migration state. The one-sided v4 pool
  is the permanent trading venue.
- Buys, sells, launch fees, trading fees, creator claims, keeper bounties, and
  platform routing are all denominated in PIPEDOG.
- Native ETH and WETH are not quote assets or operational payment paths.

The canonical active launch configs use a 1% hook fee. Seventy percent of each
trading fee is assigned to the creator lane and 30% to the platform lane.
Standard launches let the creator claim the creator lane. Self-burn launches
assign it to `LaypipeSelfBurner`, which buys and genuinely burns the launched
token.

For exact-output swaps, the hook grosses the fee up with ceiling division so
the configured percentage applies to total PIPEDOG moved, matching the gross
fee basis used by exact-input swaps.

## Wallet flows and allowances

PIPEDOG is treated as an exact-transfer, 18-decimal ERC-20 without permit.
Frontends must use a separate, exact, single-use approval transaction:

- launch: approve the factory for exactly `launchFee + firstBuyIn`;
- buy: approve `LaypipeSwapRouter` for exactly `pipedogIn`;
- sell: approve `LaypipeSwapRouter` for exactly `tokensIn` of the launched
  token.

The factory and public swap router reject both under-approval and
over-approval, then consume the exact allowance to zero on success. Never
request an unlimited allowance to the upgradeable factory. The launch, buy,
and sell entrypoints are nonpayable. Supplying native value is not a substitute
for the ERC-20 approval.

Launches accept `firstBuyMinOut`; router buys and sells accept
`minTokensOut` and `minPipedogOut`. Unspent exact-input amounts are refunded.
The contracts verify balance deltas and reject fee-on-transfer or rebasing
behavior.

## Platform revenue policy

Launch fees arrive at `PipedogRevenueRouter` directly as PIPEDOG. The hook
normally sends the platform share of trading fees there in the same sweep. If
that exact transfer fails, the hook conserves it in `platformTab()` for an
independent permissionless `collectPlatform()` retry. There is no circular
WETH/PIPEDOG buyback.

Every newly received amount is assigned:

| Lane | Gross share | Destination |
| --- | ---: | --- |
| PIPEDOG sequestration | 25% | `0x000000000000000000000000000000000000dEaD` |
| Treasury | 25% | Configured treasury wallet |
| Operations | 50% | Configured operations wallet |

`sequesterPipedog()` and `routeTreasuryPipedog()` are permissionless, capped,
and limited to one successful call per lane per block. Each pays the configured
keeper bounty from the processed 25% lane, so the dead sink or treasury
receives the lane amount less its bounty. `collectOperations()` forwards the
full operations tab and pays no bounty.

Sending PIPEDOG to `0xdead` removes it from practical circulation but does not
change ERC-20 `totalSupply`. Code, events, and product copy should call this
`sequester`, not a supply burn.

The router owner can pause the two policy lanes, rotate destinations, change
per-call caps, and, while paused, migrate all router-held PIPEDOG to a
successor contract that reports the same canonical token. This compatibility
check prevents an accidental EOA or wrong-token destination; it is not a
timelock and cannot constrain a malicious owner. The 25/25/50 split is
therefore an administrator-trusted operating policy, not an irrevocable
custody guarantee.

At the active 1% trading fee and 70/30 creator/platform split, the effective
gross trade flow is:

| Destination | Gross trade share |
| --- | ---: |
| Standard creator, or launched-token self-burn fuel | 0.700% |
| PIPEDOG dead-address sequestration | 0.075% |
| Treasury wallet | 0.075% |
| Operations wallet | 0.150% |

Launch fees do not have a creator lane; the complete launch fee enters the
router and is assigned 25% / 25% / 50%. If the operations wallet is intended
to be the developer-fee destination, that is the current developer route. It
is not a separately configurable fee and it is owner-rotatable. Product and
economic review must explicitly approve that interpretation and its effective
rates before mainnet; this documentation does not choose final economics.

## Curve calibration

Supply, tick spacing, start tick, launch fee, routing caps, and bounties have no
numeric defaults in `.env.example`. They must be explicitly reviewed in
PIPEDOG units before a deployment rehearsal.

For equal 18-decimal assets at the launch boundary:

```text
launched tokens per PIPEDOG = 1.0001 ^ startTick
implied FDV in PIPEDOG      = launched token supply / tokens per PIPEDOG
```

Generate an aligned candidate tick with the same integer `TickMath` ratios used
by the contracts:

```powershell
node scripts/calibrate-curve.mjs `
  --supply 1000000000 `
  --fdv 1000000 `
  --tick-spacing 200
```

The same inputs may be provided with `LAYPIPE_SUPPLY_TOKENS`,
`LAYPIPE_TARGET_FDV_PIPEDOG`, and `LAYPIPE_TICK_SPACING`.

Calibration is not the release gate. Put the exact candidate, global launch
fee, current hook fee assumptions, at least three increasing representative buy
sizes, and explicit FDV/depth/dust/output/impact/round-trip bounds in a review
JSON. Then run:

```powershell
node scripts/simulate-curve.mjs --review .\curve-review.json
```

Draft reviews intentionally fail while printing a source-pinned SHA-256 config
hash. After written economic review, copy that exact hash into the approval
object and rerun. The command passes only when the hash and every approved bound
match. It reports exact base units for executable buy depth, fee deductions,
token output, price impact, an immediate sell-side reversal, seed dust, and the
curve-exhaustion/partial-fill boundary. See
[CURVE_REVIEW.md](./CURVE_REVIEW.md) for the strict schema and limitations.

Tick `204200` is a legacy ETH-oriented value and an unsafe PIPEDOG example. At
a 1,000,000,000-token supply it implies an initial FDV of only about
**1.356 PIPEDOG**. Do not reuse it silently. Neither helper is an oracle,
market-quality forecast, MEV model, audit, economic endorsement, or deployment
authorization. No production curve values are selected in this repository.

## Canonical contracts

| Contract | Role | Provenance |
| --- | --- | --- |
| `LaypipeFactory` | UUPS launcher, config registry, deterministic `...cc` clones, pool seed, and optional first buy | Clean-room implementation based on public ABI and observed behavior |
| `PipedogHook` | PIPEDOG fee engine, permanent liquidity lock, fee sweep/claim, and creator-stream transfer | Reviewed derivative of verified MIT LetsCash source; quote claims and payouts were changed from native value to exact PIPEDOG |
| `LaypipeToken` | Ownerless fixed-supply clone, metadata, real holder burn, and closed-block checkpoints | Reviewed PIPEDOG and Robinhood block-clock derivative of the verified MIT mechanical adaptation |
| `LaypipeSelfBurner` | Claims PIPEDOG creator fees, pays a bounded keeper bounty, buys the launched token, and calls its real `burn()` | Reviewed PIPEDOG-quote derivative of an earlier verified MIT LetsCash source |
| `LaypipeSwapRouter` | Exact-allowance, slippage-checked PIPEDOG buy/sell entrypoint | Clean-room LayPipe implementation |
| `PipedogRevenueRouter` | Direct 25/25/50 PIPEDOG platform policy | Clean-room LayPipe implementation |

`LaypipeDividendDistributor.sol` is a quarantined research artifact. It retains
incompatible native-asset assumptions, is not imported by the factory, is not
deployed, cannot be enabled, and is excluded from canonical ABI generation.
It is not part of the LayPipe protocol surface.

## Recovery boundaries

`LaypipeFactory.sweep(address)` can move only balances held by the factory:

- factory-held PIPEDOG goes to the configured protocol treasury;
- unrelated ERC-20s and force-sent native currency go to the current owner.

It cannot reach PoolManager liquidity, hook claims, creator tabs, user
allowances, or user balances. Native recovery exists only for force-sent value;
native currency is not accepted during normal operation.

## Reference-source evidence

Reproduce the verified-source baseline and check intentional deltas:

```powershell
node scripts/fetch-reference-sources.mjs
node scripts/adapt-verified-sources.mjs
node scripts/check-source-fidelity.mjs
```

`adapt-verified-sources.mjs` writes only to
`reference/letscash/adapted-baseline/`; it must never overwrite reviewed
`src/` files. `reference/letscash/adaptation-deltas.json` classifies exact
mechanical adaptations and reviewed derivatives. Historical verified sources
under `reference/letscash/src/` are evidence only and are never deployment
inputs.

The source manifest and first-party API snapshots record acquisition time,
verification status, bytecode hashes, and drift warnings. Re-fetch them before
an audit handoff; remembered LetsCash state is not proof of current chain
state.

## Robinhood Chain wiring

The read-only preflight validates:

| Component | Value |
| --- | --- |
| Chain ID | `4663` |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| PIPEDOG | `0x5Cb6F181081301b44905F3ae15419112ecaBd8A6` |

It pins PIPEDOG, PoolManager, and Foundry deterministic-deployer runtime
bytecode; verifies PIPEDOG name, symbol, 18 decimals, total supply, and
zero-address balance; exercises the PoolManager interface; and requires a
valid Robinhood ArbSys L2 block-number response. WETH and PIPEDOG/WETH
reference constants are not dependencies of the canonical LayPipe routing
path.

### Robinhood block clock

Robinhood Chain is an Arbitrum Orbit chain. Solidity `block.number` reports a
periodically updated Ethereum L1 estimate there, so it is not a valid L2
per-block counter. Active LayPipe checkpoints, `launchBlock`, revenue-lane
guards, and self-burn guards use ArbSys precompile `0x64` and
`arbBlockNumber()` on chain ID 4663. The call fails closed if ArbSys is
unavailable. Non-Robinhood rehearsal networks use their ordinary EVM
`block.number` and remain isolated by chain-specific deployment preflights.

### Robinhood transient-storage gate

`LaypipeFactory` uses OpenZeppelin's transient reentrancy guard, so a Foundry
simulation compiled for Cancun is not sufficient evidence that the target
runtime executes EIP-1153. Run the dependency-free, read-only Node gate against
the configured Robinhood RPC:

```powershell
node scripts/check-robinhood-eip1153.mjs
```

The gate requires chain ID `4663`, captures the latest block number and hash,
and binds both `eth_call` contract-creation simulations to that exact canonical
block hash using EIP-1898. Initcode
`0x602a60005d60005c60005260206000f3` stores `0x2a` in transient slot zero,
loads it, and must return the 32-byte word `0x2a`. A separate `0xfe` initcode
control must fail with a JSON-RPC invalid-opcode error. This proves opcode
semantics without signing, deploying, broadcasting, or changing chain state.

Robinhood mainnet passed this gate on 2026-08-12 UTC at block `34176993`, hash
`0xf8cbda286e1e06fa8058360d47fd71df6678a99f6a76251a8b58486e2bdb3917`.
That observation is evidence for that runtime, not a permanent assumption;
rerun the gate immediately before every audit handoff and release candidate.

## Permissionless maintenance

Trading fees remain as Uniswap v4 claims until somebody calls
`PipedogHook.sweep(poolId)`. Sweeping redeems PIPEDOG, credits the creator tab,
and attempts an isolated exact platform route. A failed platform route is
caught and credited to the global platform tab instead of reverting the
sweep. Creator `claim(poolId)` and permissionless `collectPlatform()` therefore
remain independent: platform failure cannot roll back or freeze a creator
payout, and treasury rotation does not orphan deferred platform credit. None
of these maintenance calls pays a bounty.

The keyless `script/SweepHookFees.s.sol` helper reads only public inputs and
skips pools below an optional PIPEDOG threshold. Revenue routing and
self-burns have separate permissionless bounty flows. Operational details are
in [KEEPERS.md](./KEEPERS.md).

## Build and release checks

Foundry uses Solidity `0.8.28`, Cancun, optimizer 800 runs, and IR compilation.
Dependencies are pinned by commit in `scripts/install-deps.ps1`.

Fresh dependency install:

```powershell
.\scripts\install-deps.ps1
```

Complete release-candidate verification:

```powershell
forge clean
forge build
forge build --sizes
$env:ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
forge test -vv
node scripts\check-source-fidelity.mjs
node scripts\generate-abis.mjs
git diff --exit-code -- abi
```

For a production candidate, the exact approved economics artifact is an
additional mandatory gate:

```powershell
node scripts\simulate-curve.mjs --review <approved-curve-review.json>
```

The automated curve fixtures test the model; they do not substitute for this
release-specific review.

Committed frontend/indexer ABIs live in `abi/`. The generator exports only the
canonical protocol surface and removes any stale dividend ABI.

The source-fidelity report is provenance evidence, not a complete source or
release-version lock: reviewed derivatives are expected to differ from their
mechanical baselines, and the clean-room contracts have no upstream baseline.
An audit handoff must therefore bind the complete commit, compiler settings,
dependency revisions, generated ABIs, and deployment artifacts together.

### Frontend release identity

A UUPS proxy address does not identify the code currently serving it. Before
enabling browser mutations, record an audited deployment manifest containing:

- chain ID, deployment block, source commit, compiler settings, and ABI hashes;
- proxy and implementation addresses plus runtime codehashes;
- token implementation, hook, self-burner, swap router, and revenue-router
  addresses and runtime codehashes;
- final owner, treasury, operations wallet, config IDs, and exact config
  values;
- the passing curve-review config hash and retained simulation report; and
- canonical PIPEDOG and PoolManager bindings.

The factory implementation is stored at the standard EIP-1967 implementation
slot
`0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`.
The frontend must read that slot, fetch the implementation runtime, and fail
closed unless its address and codehash match the audited manifest. Checking
only the proxy address, public getters, or `UPGRADE_INTERFACE_VERSION()` is
not a version check: an upgraded implementation can preserve or spoof those
surfaces. Any factory upgrade requires a new reviewed manifest, and launch
mutations must remain disabled until the frontend and indexer accept it. The
factory also rejects upgrades while its global launch gate is open. The UUPS
test suite checks two-step ownership, pending/old-owner rejection, EIP-1967
slot identity, proxy/runtime codehash separation, invalid implementations,
initializer closure, and storage preservation across an appended-state mock.

## No-broadcast deployment rehearsal

Copy `.env.example` to the ignored `.env` and fill every blank. Economic values
are PIPEDOG base units or explicit curve parameters:

- `LAYPIPE_SUPPLY_WEI`
- `LAYPIPE_TICK_SPACING`
- `LAYPIPE_START_TICK`
- `LAYPIPE_LAUNCH_FEE_PIPEDOG_WEI`
- `MAX_SEQUESTER_PER_CALL_PIPEDOG_WEI`
- `MAX_TREASURY_ROUTE_PER_CALL_PIPEDOG_WEI`
- `MAX_SELF_BURN_PER_CALL_PIPEDOG_WEI`
- `ROUTER_BOUNTY_BPS`
- `SELF_BURN_BOUNTY_BPS`

Keep `DEPLOYER_PRIVATE_KEY` only in ignored local configuration. Never print,
commit, or pass it in the process list.

Run the read-only chain gate:

```powershell
node scripts/check-robinhood-eip1153.mjs

forge script script/PreflightRobinhood.s.sol:PreflightRobinhood `
  --rpc-url robinhood -vv
```

Simulate the complete deployment without broadcasting:

```powershell
forge script script/DeployLaypipe.s.sol:DeployLaypipe `
  --rpc-url robinhood -vvv
```

The script deploys and wires the PIPEDOG revenue router, UUPS factory proxy,
token implementation, mined-address hook, self-burner, and swap router. It adds
an enabled standard config and a disabled self-burn config, transfers ownership
in two steps, prints the implied PIPEDOG FDV, and leaves global launch disabled.
Do not enable the self-burn config until its permissionless execution has an
independently audited, attacker-independent price-protection design.

The final owner must accept ownership on the factory, hook, and revenue router
before any funding or enablement. Do not add `--broadcast` until an independent
audit, source-verification plan, ownership-acceptance plan, economic review,
and explicit authorization are complete.

## Base Sepolia rehearsal (test only)

Canonical PIPEDOG does not exist on Base Sepolia. The isolated rehearsal path
therefore deploys `MockPipedogBaseSepolia`, a fixed-supply vanilla 18-decimal
ERC-20 with no owner, tax, rebase, permit, or post-deployment mint path. It then
deploys the same LayPipe stack against Uniswap v4's official Base Sepolia
PoolManager and leaves launches disabled. Robinhood config and the production
deployment script are not reused or modified.

The rehearsal preflight pins both the official PoolManager address and its
deployed runtime codehash. It also pins Foundry's deterministic deployment
proxy runtime, then exercises the PoolManager interface before deployment.
This makes an address-preserving or interface-compatible runtime change fail
closed until the expected dependency is reviewed and deliberately updated.

The official Base Sepolia network is chain ID `84532`; its public RPC is
`https://sepolia.base.org`. The protocol dependency is Uniswap v4 PoolManager
`0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408`. The complete official v4 address
set is recorded in `script/BaseSepoliaConfig.sol` from:

`https://developers.uniswap.org/docs/protocols/v4/deployments#base-sepolia-84532`

Run the live read-only gate:

```powershell
forge script script/PreflightBaseSepolia.s.sol:PreflightBaseSepolia `
  --rpc-url base_sepolia -vv
```

Fill every `BASE_SEPOLIA_*` test value in the ignored `.env`, then simulate the
complete deployment without broadcasting:

```powershell
forge script script/DeployLaypipeBaseSepolia.s.sol:DeployLaypipeBaseSepolia `
  --rpc-url base_sepolia -vvv
```

The rehearsal mines a lower-half mock quote address so launched-token vanity
mining can reliably preserve quote-token `currency0` ordering. It deploys the
mock quote, revenue router, UUPS factory proxy, token implementation,
flag-mined hook, self-burner, swap router, an enabled standard config, and a
disabled self-burn config; transfers ownership in two steps; and leaves global
launches disabled.

A dry run on August 11, 2026 estimated `18,870,783` gas and
`0.000207578613 ETH` at that block's gas price. That estimate will move. Fund
the Base Sepolia deployer with test ETH from an official Base-listed faucet;
`0.002 ETH` is a practical rehearsal buffer for deployment plus ownership and
smoke-test transactions. Never fund or treat mock tPIPEDOG as an asset, and do
not add `--broadcast` without explicit authorization and the independent audit
required by [SECURITY.md](./SECURITY.md).
