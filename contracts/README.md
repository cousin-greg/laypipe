# Laypipe protocol

Foundry implementation of the laypipe.fun launcher for Robinhood Chain. It
recreates the observable LetsCash launch flow around PIPEDOG:

- fixed-supply `...cc` token clone;
- atomic Uniswap v4 pool initialization, one-sided liquidity seed, and optional
  first buy;
- permanently locked launch liquidity;
- fixed 1% fee collected in native ETH on buys and sells;
- transferable creator fee stream;
- standard and self-burn launch modes;
- platform revenue routed through the fixed 25/25/50 PIPEDOG policy.

Status: implementation and tests are complete, but the contracts are
**unaudited and not deployed**. Do not broadcast the deployment script until an
independent review is complete. See [SECURITY.md](./SECURITY.md).

## PIPEDOG semantics

PIPEDOG is fixed at:

`0x5Cb6F181081301b44905F3ae15419112ecaBd8A6`

PIPEDOG does not expose `burn()`. The platform lane therefore buys PIPEDOG and
sends it to `0x000000000000000000000000000000000000dEaD`. This removes tokens
from practical circulation but **does not reduce ERC-20 `totalSupply`**.
Contracts, events, counters, and this documentation call that action
`sequester`.

This is distinct from a Laypipe token's self-burn mode. Launched tokens do
expose `burn()`, so self-burn purchases genuinely reduce that token's
`totalSupply`.

## Runtime policy

The enabled launch configs mirror the live observable LetsCash configs 16 and
17:

| Setting | Value |
| --- | ---: |
| Supply | 1,000,000,000 tokens |
| Tick spacing | 200 |
| Start tick | 204,200 |
| Trading fee | 10,000 pips = 1% |
| Creator share of trading fee | 7,000 bps = 70% |
| Platform share of trading fee | 3,000 bps = 30% |
| Launch fee | 0.0005 ETH |
| Address suffix | `0xcc` |

During normal operation, `PipedogRevenueRouter` assigns every new wei it
receives:

| Lane | Share | Destination |
| --- | ---: | --- |
| PIPEDOG sequestration | 25% | Market buy to `0xdead` |
| Treasury acquisition | 25% | Market buy to treasury |
| Operations | 50% | Operations wallet in ETH |

Both buy lanes are permissionless, pay a 1% keeper bounty, cap each order, and
run at most once per lane per block. The split percentages are constants. Admin
can pause buys, rotate the two destination wallets, tune order caps, or migrate
all platform-owned ETH to a successor router. The 25/25/50 split is therefore a
fixed operating policy, not an irrevocable custody guarantee.

## Contracts

| Contract | Role | Provenance |
| --- | --- | --- |
| `LaypipeFactory` | UUPS launcher, config registry, deterministic `...cc` clones, atomic pool seed/first buy | Clean-room implementation of live public ABI and observed behavior; active LetsCash implementation is unverified |
| `PipedogHook` | 1% ETH fee engine, sweep/claim/updateCreator, immutable liquidity lock | Mechanically name-adapted from fully verified MIT source with no intentional semantic delta |
| `LaypipeToken` | Ownerless fixed-supply clone, metadata, real holder burn, closed-block checkpoints | Mechanically name-adapted from fully verified MIT source with no intentional semantic delta |
| `LaypipeSelfBurner` | Claims creator lane, buys its own launched token, calls real `burn()` | Mechanically name-adapted from an earlier verified MIT source with no intentional semantic delta; current live burner is unverified |
| `PipedogRevenueRouter` | Canonical 25/25/50 platform destination | Clean-room implementation of first-party API behavior; live splitter source is unverified |
| `LaypipeDividendDistributor` | Research parity artifact only | Reviewed derivative of verified source; **not deployed and impossible to enable in this factory version** |

The canonical deployment script deploys only the factory, token implementation,
hook, self-burner, and `PipedogRevenueRouter`. A historical single-burner
adaptation is retained under `reference/` only; it is not a competing
deployment surface.

### Factory recovery compatibility

`LaypipeFactory.sweep(address)` matches the observed live owner-only selector
`0x01681a62` and empty return. Native ETH is sent to the configured factory
treasury. The live factory also sends ERC20 recovery to its treasury, while
Laypipe intentionally sends ERC20s to the current owner because its revenue
router has no arbitrary-token recovery function and would otherwise strand
them. Laypipe additionally emits `Swept` and uses its local
`EtherTransferFailed` error. These are documented clean-room deltas, not claims
of bytecode parity. The function can move only balances held by the factory
address itself; it cannot reach PoolManager liquidity or user balances.

## Verified reference acquisition

Reproduce the source and current first-party API snapshots:

```powershell
node scripts/fetch-reference-sources.mjs
node scripts/adapt-verified-sources.mjs
node scripts/check-source-fidelity.mjs
```

`adapt-verified-sources.mjs` writes only to
`reference/letscash/adapted-baseline/`. It can never overwrite reviewed
`src/` files. `adaptation-deltas.json` declares which mechanically adapted
source files must remain text-identical to the generated baseline and which
contain intentional reviewed changes.

The API snapshots include their acquisition time and a drift warning. Re-fetch
before any deployment review. Exact verified source metadata, deployed bytecode
hashes, and unavailable/unverified live components are recorded in
`reference/letscash/manifest.json`.

## Chain wiring

The read-only preflight validates all of these against chain state:

| Component | Address |
| --- | --- |
| Robinhood Chain ID | `4663` |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| PIPEDOG | `0x5Cb6F181081301b44905F3ae15419112ecaBd8A6` |
| PIPEDOG/WETH v3 pool | `0xB7f10f74B39291b9290b779978e19A7637C742D6` |
| v3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| Pool fee | `10,000` = 1% |

The router constructor independently verifies pool bytecode, pair, fee,
reported factory, and canonical `factory.getPool` result. Its callback only
honors the authenticated pool during a router-initiated swap and cannot collect
more WETH than the transient per-swap allowance.

## Permissionless fee sweeps

Trading fees remain as v4 claims until somebody calls
`PipedogHook.sweep(poolId)`. Active pools can be swept by normal automation;
dormant pools need a gas-aware keeper. The keyless
`script/SweepHookFees.s.sol` helper checks pending value and skips pools below
an optional threshold. Hardware-wallet and unlocked-account commands are in
[KEEPERS.md](./KEEPERS.md). The script never reads the deployment key or any
other secret.

## Build and test

Foundry stable `1.7.1`, Solidity `0.8.28`, Cancun, optimizer 800 runs, and IR
compilation were used. Compiler settings match the verified LetsCash hook
metadata. Dependencies are pinned by commit in `scripts/install-deps.ps1`.

Fresh install and build:

```powershell
.\scripts\install-deps.ps1
```

Normal verification:

```powershell
forge clean
forge build
$env:ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
forge test -vv
node scripts\check-source-fidelity.mjs
node scripts\generate-abis.mjs
```

The current suite passes 32 tests:

- 13 revenue-router unit/fuzz tests, including malicious callbacks and the
  99-wei bounty-rounding boundary;
- 3 invariants, 256 runs × 64 calls;
- 12 factory/hook tests against the canonical live v4 PoolManager on a fork;
- 1 launched-token historical checkpoint test;
- 3 live preflight/differential tests, including an actual canonical
  PIPEDOG/WETH v3 purchase into the dead sink with unchanged `totalSupply`.

Committed frontend/indexer ABIs live in `abi/`. Regenerate deterministically
after every contract change with:

```powershell
forge build
node scripts\generate-abis.mjs
```

## Deployment dry run

Copy `.env.example` to the ignored `.env` and fill in:

- `DEPLOYER_PRIVATE_KEY`;
- `FINAL_OWNER` (preferably a Safe);
- `TREASURY_WALLET`;
- `OPERATIONS_WALLET`.

The key is read inside the Forge script. It is never passed in the CLI process
list or logged.

Run the live read-only gate:

```powershell
forge script script/PreflightRobinhood.s.sol:PreflightRobinhood `
  --rpc-url robinhood -vv
```

Simulate the complete deployment without broadcasting:

```powershell
forge script script/DeployLaypipe.s.sol:DeployLaypipe `
  --rpc-url robinhood -vvv
```

The script:

1. validates chain, token, WETH, pool, fee, factory, and pool liquidity;
2. deploys the fixed 25/25/50 router;
3. deploys the UUPS factory proxy with global launch disabled;
4. mines and deploys the hook through canonical CREATE2 with exact v4 flags;
5. wires the token implementation and self-burner;
6. installs standard and self-burn configs;
7. asserts factory ↔ hook ↔ router wiring;
8. starts two-step ownership transfer to `FINAL_OWNER`.

The final owner must accept ownership on the factory, hook, and router. Launch
remains disabled until that owner reviews the deployment and explicitly calls
`factory.setLaunchEnabled(true)`.

Do not add `--broadcast` before an independent audit, source-verification plan,
Safe acceptance transaction plan, and frontend/indexer address cutover are
ready.
