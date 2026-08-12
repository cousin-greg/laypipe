# Permissionless keeper operations

LayPipe has three independent permissionless maintenance paths:

1. sweep v4 fee claims into real PIPEDOG;
2. process the platform revenue lanes;
3. execute bounded self-burns.

A permissionless write is still a signed, gas-paying transaction. Only the
revenue-lane and self-burn calls pay a PIPEDOG bounty. Hook fee sweeps do not.

## Sweep hook fees

`PipedogHook.sweep(poolId)` redeems a pool's pending Uniswap v4 fee claims into
PIPEDOG, credits the creator lane in `tab(poolId)`, and transfers the platform
lane to the configured `PipedogRevenueRouter`.

The helper at `script/SweepHookFees.s.sol` reads only public inputs. It never
loads a private key, mnemonic, password, deployment key, or deployment `.env`.

Inputs:

- `LAYPIPE_HOOK`: deployed LayPipe hook address;
- `POOL_ID`: the `bytes32` pool ID emitted by `TokenLaunched`;
- `MIN_PENDING_PIPEDOG_WEI`: optional threshold below which no transaction is
  created;
- `ROBINHOOD_RPC_URL`: public Robinhood Chain endpoint.

Confirm the hook address against the reviewed deployment record. Never accept
an address supplied only by an untrusted token page.

Read and simulate in PowerShell:

```powershell
$env:LAYPIPE_HOOK = "0x..."
$env:POOL_ID = "0x..."
$env:MIN_PENDING_PIPEDOG_WEI = "1000000000000000000"
$env:ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
$keeper = "0x..."

cast call $env:LAYPIPE_HOOK "pending(bytes32)(uint256)" $env:POOL_ID `
  --rpc-url $env:ROBINHOOD_RPC_URL

forge script script/SweepHookFees.s.sol:SweepHookFees `
  --rpc-url $env:ROBINHOOD_RPC_URL --sender $keeper -vv
```

The simulation prints pending PIPEDOG and creates no transaction when the
amount is zero or below `MIN_PENDING_PIPEDOG_WEI`. The threshold covers total
pending fees; only the configured platform share goes to the revenue router.
Compare the PIPEDOG value of that share with native gas cost before
broadcasting.

Use a hardware wallet to broadcast:

```powershell
forge script script/SweepHookFees.s.sol:SweepHookFees `
  --rpc-url $env:ROBINHOOD_RPC_URL --sender $keeper `
  --ledger --broadcast -vv
```

Do not put a raw private key on the command line or in the keeper environment
variables. Do not use `--unlocked` against the public Robinhood RPC; it does
not host your signer.

A production sweeper should discover pool IDs from canonical `TokenLaunched`
events, query `pending(poolId)`, apply a gas-aware threshold, and deduplicate
successful transactions. Do not derive a pool ID from the token address alone.
A zero-pending sweep is harmless but unnecessary.

After a successful sweep:

- `pending(poolId)` should decrease to zero;
- `FeesSwept` records the PIPEDOG amounts;
- creator PIPEDOG remains in `tab(poolId)` until the current fee recipient
  calls `claim(poolId)`;
- platform PIPEDOG is held by the revenue router as unallocated revenue.

There is no deferred platform balance or retry path. Platform transfer failure
reverts the entire sweep.

## Process platform revenue

The revenue router lazily assigns every unallocated PIPEDOG receipt 25% to
sequestration, 25% to treasury, and the rounding remainder/50% lane to
operations. The processing calls invoke allocation automatically:

```text
sequesterPipedog()
routeTreasuryPipedog()
collectOperations()
```

`sequesterPipedog()` and `routeTreasuryPipedog()`:

- process no more than their configured PIPEDOG cap;
- run at most once per lane per Robinhood L2 block (read from ArbSys, not the
  coarser Solidity `block.number` L1 estimate);
- pay `bountyBps` from the processed lane to the caller;
- transfer the remainder directly to `0xdead` or the configured treasury.

They perform no market swap and require no slippage setting. They revert when
paused or when their lane has nothing to process.

`collectOperations()` sends the complete operations tab to the configured
operations destination. It pays no bounty and is not stopped by the policy-lane
pause.

Operators should monitor:

- `unallocated()`, `sequesterTank()`, `treasuryTank()`, and `operationsTab()`;
- current per-call caps and `bountyBps()`;
- `PipedogSequestered`, `TreasuryPipedogRouted`, and
  `OperationsPipedogCollected`;
- PIPEDOG balance conservation against cumulative counters.

## Execute self-burns

For self-burn pools, `LaypipeSelfBurner.burn(poolId)`:

1. calls the hook claim path when the pool has pending or tabbed creator fees;
2. adds the received PIPEDOG to that pool's `unburned` tank;
3. processes at most immutable `maxBurnPerCall`;
4. pays the caller `bountyBps` from that chunk;
5. swaps the remainder for the launched token and calls its real `burn()`.

Each pool can process at most once per Robinhood L2 block, read from ArbSys. A
zero-output attempt reverts and
does not pay a bounty. Unspent quote from a partial execution is restored to
the pool's `unburned` tank.

Self-burns intentionally have no minimum output and may be sandwiched. Keepers
should simulate against current curve state and should not treat the bounty as
a guarantee of profitable or safe execution.

Verify a successful call with the `Burned` event, a lower launched-token
`totalSupply`, and the expected PIPEDOG bounty. PIPEDOG itself is not burned by
this flow.
