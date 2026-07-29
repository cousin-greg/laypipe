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

Launch fees and the platform share of trading fees arrive at
`PipedogRevenueRouter` directly as PIPEDOG. There is no circular
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
per-call caps, and migrate all router-held PIPEDOG to a successor. The
25/25/50 split is therefore an administrator-trusted operating policy, not an
irrevocable custody guarantee.

## Curve calibration

Supply, tick spacing, start tick, launch fee, routing caps, and bounties have no
numeric defaults in `.env.example`. They must be explicitly reviewed in
PIPEDOG units before a deployment rehearsal.

For equal 18-decimal assets at the launch boundary:

```text
launched tokens per PIPEDOG = 1.0001 ^ startTick
implied FDV in PIPEDOG      = launched token supply / tokens per PIPEDOG
```

Generate an aligned candidate tick:

```powershell
node scripts/calibrate-curve.mjs `
  --supply 1000000000 `
  --fdv 1000000 `
  --tick-spacing 200
```

The same inputs may be provided with `LAYPIPE_SUPPLY_TOKENS`,
`LAYPIPE_TARGET_FDV_PIPEDOG`, and `LAYPIPE_TICK_SPACING`.

Tick `204200` is a legacy ETH-oriented value and an unsafe PIPEDOG example. At
a 1,000,000,000-token supply it implies an initial FDV of only about
**1.356 PIPEDOG**. Do not reuse it silently. The helper is a deterministic
configuration aid, not an oracle, liquidity simulation, or economic
endorsement.

## Canonical contracts

| Contract | Role | Provenance |
| --- | --- | --- |
| `LaypipeFactory` | UUPS launcher, config registry, deterministic `...cc` clones, pool seed, and optional first buy | Clean-room implementation based on public ABI and observed behavior |
| `PipedogHook` | PIPEDOG fee engine, permanent liquidity lock, fee sweep/claim, and creator-stream transfer | Reviewed derivative of verified MIT LetsCash source; quote claims and payouts were changed from native value to exact PIPEDOG |
| `LaypipeToken` | Ownerless fixed-supply clone, metadata, real holder burn, and closed-block checkpoints | Reviewed documentation-only PIPEDOG derivative of the verified MIT mechanical adaptation; executable semantics are unchanged |
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

It also pins PIPEDOG bytecode and verifies its name, symbol, 18 decimals, total
supply, zero-address balance, and PoolManager interface compatibility. WETH
and PIPEDOG/WETH reference constants are not dependencies of the canonical
LayPipe routing path.

## Permissionless maintenance

Trading fees remain as Uniswap v4 claims until somebody calls
`PipedogHook.sweep(poolId)`. Sweeping redeems PIPEDOG, credits the creator tab,
and sends the platform share to the revenue router. The fee sweep itself pays
no bounty.

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
$env:ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
forge test -vv
node scripts\check-source-fidelity.mjs
node scripts\generate-abis.mjs
```

Committed frontend/indexer ABIs live in `abi/`. The generator exports only the
canonical protocol surface and removes any stale dividend ABI.

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
standard and self-burn configs, transfers ownership in two steps, prints the
implied PIPEDOG FDV, and leaves launch disabled.

The final owner must accept ownership on the factory, hook, and revenue router
before any funding or enablement. Do not add `--broadcast` until an independent
audit, source-verification plan, ownership-acceptance plan, economic review,
and explicit authorization are complete.
