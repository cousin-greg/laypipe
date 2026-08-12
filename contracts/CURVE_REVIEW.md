# PIPEDOG curve review gate

No production curve is approved by this repository. The economic reviewer must
choose every PIPEDOG-denominated value and risk bound. The scripts here make
that decision reproducible; they do not make it.

## Two-step gate

First, calculate the closest tick-spacing-aligned launch boundary for an
explicit supply and target FDV:

```powershell
node scripts/calibrate-curve.mjs `
  --supply <whole-token-decimal> `
  --fdv <whole-PIPEDOG-decimal> `
  --tick-spacing <integer>
```

The calibration search uses the same integer `TickMath` ratios as Uniswap v4.
Exact base units in its JSON output are authoritative; six-decimal display
strings are truncated for readability. A candidate tick is not an approval.

Second, create a review JSON and run the executable-depth gate:

```powershell
node scripts/simulate-curve.mjs --review .\curve-review.json
```

The first run must use `approval.status: "draft"` and an empty
`approval.configHash`. It prints the exact `gate.computedConfigHash` and exits
non-zero. Review the full report, update assumptions or bounds as needed, then
have the economic reviewer copy that hash into `approval.configHash`, set the
status to `approved`, and record their identity and review time. The second run
exits zero only when the hash and every approved bound pass.

Any change to the reviewed inputs or the pinned model/contract source files
changes the SHA-256 hash and invalidates the approval. Source text is normalized
to LF before hashing, so the hash is stable across Windows and Unix checkouts.
The hash payload also records the Uniswap v4 dependency commits from the
tracked installer; the release process must still perform a fresh pinned
dependency install and run the Solidity cross-check.
The hash is an integrity identifier, not a cryptographic signature or proof of
the reviewer's identity; the release process must preserve the separate written
sign-off.
The approved review JSON, passing report, and config hash must be retained with
the release evidence. Do not infer approval from a CI pass or a developer name
in an automated fixture.

## Review file shape

All `...Wei` fields are canonical unsigned decimal strings. They are 18-decimal
base units, not JavaScript numbers and not whole-token display values. The gate
rejects missing and extra keys so an unmodeled value cannot slip through the
approval hash.

This schematic deliberately contains placeholders and is not executable or a
production recommendation:

```jsonc
{
  "schemaVersion": 1,
  "model": "laypipe-v4-one-sided-pipedog-v1",
  "chainId": 4663,
  "quoteToken": "0x5Cb6F181081301b44905F3ae15419112ecaBd8A6",
  "quoteDecimals": 18,
  "tokenDecimals": 18,
  "launchConfig": {
    "supplyWei": "<reviewed launch-token base units>",
    "tickSpacing": "<JSON integer>",
    "startTick": "<JSON integer from calibration>",
    "creatorFeeBps": 7000,
    "baseFeeRatePips": 10000,
    "launchFeeRatePips": 10000,
    "launchFeeDecaySeconds": 0,
    "launchFeePipedogWei": "<reviewed PIPEDOG base units>",
    "selfBurn": false,
    "enabled": true
  },
  "reviewBounds": {
    "targetInitialFdvPipedogWei": "<reviewed PIPEDOG base units>",
    "maxInitialFdvErrorBps": "<JSON integer>",
    "maxLaunchFeeBpsOfTargetFdv": "<JSON integer>",
    "minimumNetCurveCapacityPipedogWei": "<reviewed PIPEDOG base units>",
    "maxSeedDustTokenWei": "<reviewed token base units>",
    "representativeBuys": [
      {
        "label": "small",
        "grossPipedogInWei": "<reviewed PIPEDOG base units>",
        "buyFeeRatePips": 10000,
        "sellFeeRatePips": 10000,
        "minTokensOutWei": "<reviewed token base units>",
        "maxSpotPriceImpactBps": "<JSON integer>",
        "maxAverageGrossPriceImpactBps": "<JSON integer>",
        "maxRoundTripLossBps": "<JSON integer>"
      },
      {
        "label": "medium",
        "grossPipedogInWei": "<larger reviewed amount>",
        "buyFeeRatePips": 10000,
        "sellFeeRatePips": 10000,
        "minTokensOutWei": "<reviewed token base units>",
        "maxSpotPriceImpactBps": "<JSON integer>",
        "maxAverageGrossPriceImpactBps": "<JSON integer>",
        "maxRoundTripLossBps": "<JSON integer>"
      },
      {
        "label": "large",
        "grossPipedogInWei": "<largest reviewed amount>",
        "buyFeeRatePips": 10000,
        "sellFeeRatePips": 10000,
        "minTokensOutWei": "<reviewed token base units>",
        "maxSpotPriceImpactBps": "<JSON integer>",
        "maxAverageGrossPriceImpactBps": "<JSON integer>",
        "maxRoundTripLossBps": "<JSON integer>"
      }
    ]
  },
  "approval": {
    "status": "draft",
    "configHash": "",
    "reviewer": "",
    "reviewedAt": ""
  }
}
```

The current factory will enable only its fixed active fee policy:
`creatorFeeBps=7000`, `baseFeeRatePips=10000`,
`launchFeeRatePips=10000`, and `launchFeeDecaySeconds=0`. The gate checks those
values against the current source. They are protocol constraints, not a new
economic choice made by the simulator.

At least three scenarios are required, labels must be stable and unique, and
gross buy sizes must be strictly increasing. Each scenario is simulated from
the initial launch boundary; the scenarios are not executed sequentially.

## What the report proves

The model reproduces the current single-position mechanics with integer
arithmetic:

- the minimum usable tick and selected start tick;
- `LiquidityAmounts.getLiquidityForAmount1` and seed-token rounding/dust;
- launch-boundary tokens per PIPEDOG and implied FDV, including the separately
  rounded `CurveEconomics` helper value printed by the deployment script;
- cumulative net PIPEDOG needed to reach the lower tick;
- the maximum gross buy at the fixed hook fee, plus the one-base-unit
  partial-fill boundary the hook rejects;
- gross input, hook fee, pool input, tokens received, ending tick, curve
  utilization, and conservative basis-point price-impact ceilings for each
  reviewed buy, plus `launchFee + firstBuyIn` as the exact launch allowance if
  that scenario is used for the creator's first buy; both ending spot impact
  and fee-inclusive average execution impact have independent approved caps;
- an immediate sell of the exact bought tokens through the same range,
  including integer rounding, the sell-side hook fee, net PIPEDOG returned,
  and round-trip loss.

The exhaustion value is cumulative curve capacity. When it exceeds the
conservative `BalanceDelta.int128` single-swap limit, the report says so; it
must not be presented as one executable transaction. The fee-inclusive gross
boundary is therefore labeled one-call arithmetic: total gross PIPEDOG across
many swaps can differ because the hook rounds its fee separately on every
transaction. A representable public exact-input buy that crosses the curve
boundary is a partial fill and reverts in the current hook.

The JavaScript math is regression-checked against the imported Solidity
`TickMath`, `SqrtPriceMath`, and `LiquidityAmounts` implementations in
`test/CurveSimulationMath.t.sol`. The automated numeric fixture exists only to
detect code drift and is not a recommended launch config.

## What it does not prove

The model assumes the current zero-LP-fee, one-sided, single-range v4 pool and
the current exact-input PIPEDOG hook-fee paths. It does not model or approve:

- mempool ordering, sandwiching, back-running, or any other MEV;
- a TWAP, oracle, or self-burn price guard (none is supplied by this gate);
- demand, PIPEDOG's external market value, latency, gas, or future order flow;
- alternate pools or fee leakage outside LayPipe;
- sequential user activity or an intervening trade between the modeled buy and
  sell reversal;
- exact-output swap paths, RPC behavior, contract security, governance, or
  deployment operations.

A passing report is a narrow arithmetic assertion about the exact approved
inputs. It is not a market-quality forecast, independent audit, economic
endorsement, or authorization to deploy. Self-burn remains separately disabled
until its permissionless market order has an independently audited price guard;
the current gate refuses an enabled `selfBurn: true` review for that reason.
