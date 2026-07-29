# Permissionless fee-sweep keeper

`PipedogHook.sweep(poolId)` converts a pool's pending Uniswap v4 fee claims
into real ETH, credits the creator lane, and forwards the platform lane to the
configured revenue router. It is permissionless, but it does not pay a keeper
bounty. Dormant pools therefore need an operator to sweep when pending value
comfortably exceeds gas cost. Permissionless does not mean signatureless: a
write transaction still needs a gas-paying signer. Because an unrelated keeper
has no direct economic incentive, this should be protocol-funded or run by an
interested creator.

The helper at `script/SweepHookFees.s.sol` reads only public inputs. It never
loads a private key, mnemonic, password, or deployment `.env`.

## Inputs

- `LAYPIPE_HOOK`: deployed Laypipe hook address.
- `POOL_ID`: the `bytes32` pool ID emitted by `TokenLaunched`.
- `MIN_PENDING_WEI`: optional threshold below which the script creates no
  transaction.
- `ROBINHOOD_RPC_URL`: public chain endpoint used by Forge.

Confirm the hook address against the reviewed deployment record. Never accept
an address supplied by an untrusted token page.

## Read and simulate

PowerShell:

```powershell
$env:LAYPIPE_HOOK = "0x..."
$env:POOL_ID = "0x..."
$env:MIN_PENDING_WEI = "100000000000000"
$env:ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com"
$keeper = "0x..."

cast call $env:LAYPIPE_HOOK "pending(bytes32)(uint256)" $env:POOL_ID `
  --rpc-url $env:ROBINHOOD_RPC_URL

forge script script/SweepHookFees.s.sol:SweepHookFees `
  --rpc-url $env:ROBINHOOD_RPC_URL --sender $keeper -vv
```

The simulation prints the pending amount and produces no transaction when it
is zero or below `MIN_PENDING_WEI`. The threshold covers total pending fees;
only the configured platform share benefits the protocol treasury.

## Broadcast without exposing a raw key

Use a hardware wallet:

```powershell
forge script script/SweepHookFees.s.sol:SweepHookFees `
  --rpc-url $env:ROBINHOOD_RPC_URL --sender $keeper `
  --ledger --broadcast -vv
```

Do not put a raw private key on the command line or in these environment
variables. Do not use `--unlocked` against the public Robinhood RPC; it does not
host your signer. A production keeper should discover pool IDs from canonical
`TokenLaunched` events (topic 0
`0x17091df68f499cf4e20dcfc5d42f064dd22359e785b77691c4c4ed0322608897`,
with the indexed pool ID in topic 3), query `pending(poolId)`, enforce a
gas-aware threshold, and deduplicate successful transactions. Do not derive a
pool ID from the token address alone. A zero-pending sweep is harmless, but
unnecessary.

After a sweep, creator ETH remains in `tab(poolId)` until that creator calls
`claim(poolId)`. If the platform treasury rejects ETH, the platform amount is
parked in `platformTab`; anyone can retry delivery with `collectPlatform()`.
For an inactive pool, verify `pending(poolId) == 0` and a `FeesSwept` log with
topic 0
`0x6d2933eb430d4f99a7eec0cae60f3c00dd9327353067268bf364abdce51cacb8`.
A `PlatformPayoutDeferred` log with topic 0
`0xe8c4064bfde4e911c80bfaa187dc09564e707213cb72f5197cae99f2a46a3197`
means the sweep succeeded but treasury delivery was deferred.
