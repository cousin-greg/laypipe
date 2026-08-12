# LayPipe token trading

The token-detail trade panel is fail-closed. It activates only when live market
mode supplies a canonical indexed token/pool identity and every field in the
audited Robinhood production deployment manifest is present. Fixture tokens,
test-only manifests, incomplete manifests, identity mismatches, and unverified
runtime code keep wallet actions disabled.

## Asset and approval rules

- PIPEDOG is currency0 and the only quote asset. Buys spend PIPEDOG; sells spend
  the launched token. Native ETH is used only for transaction gas.
- The `LaypipeSwapRouter` must receive an allowance equal to the input amount.
  The interface never requests an unlimited allowance.
- A wrong nonzero allowance is reset to zero first, followed by a separate
  exact approval. The exact approval is single-use: a successful router pull
  consumes it. If an approval succeeds but the swap does not, the panel exposes
  an explicit allowance-clear transaction.

## Trusted quote sequence

The indexed last price is display-only and is never used to build `minOut`.
Because the router itself requires exact allowance, a trusted quote is prepared
only after that exact allowance is confirmed on-chain:

1. Verify chain ID, the complete audited deployment snapshot, all runtime code
   hashes and bindings, the indexed PoolKey, and the immutable launch-token
   clone/runtime bindings at one block.
2. Verify the selected account, input-token balance, and exact allowance.
3. Simulate the complete router buy/sell call with `minOut = 0` to obtain the
   current expected output. The calldata already binds the canonical-chain
   block deadline derived from that verified snapshot. This call is read-only
   and cannot be submitted.
4. Derive a nonzero minimum output from the selected bounded slippage (0.5% to
   5%). Quotes expire after 30 seconds or three canonical chain blocks. The
   router independently rejects both buys and sells after `deadlineBlock`; on
   Robinhood it reads the L2 block from ArbSys, not Solidity's L1-estimate
   `block.number`.
5. Immediately before submission, repeat the full manifest, token, account,
   balance, and exact-allowance preflight. Validate quote ownership, pool,
   token, age, block drift, and minimum-output calculation.
6. Simulate the actual calldata with the protected nonzero `minOut`, estimate
   gas, then immediately reread the wall clock, L2 head, selected chain, and
   selected account before asking the wallet to submit the exact deadline-bound
   calldata. No native `value` is attached.

Receipt confirmation uses a direct read-only Robinhood RPC rather than trusting
only the injected wallet provider. It requires two canonical blocks, binds the
transaction hash, sender, audited target, exact input calldata, zero native
value, receipt block hash/number, and block transaction membership, and then
requires exactly one matching `Bought` or `Sold` event with the expected pool,
sender, recipient, and amount bounds. The input allowance is reread from that
same independent RPC at the receipt block. Approval confirmations receive the
same transaction binding, and an allowance-clear is not treated as complete
until the independent reread returns zero.

## Transaction lifecycle

The panel surfaces approval and trade hashes as soon as the wallet returns
them. A receipt timeout is treated as an unknown pending state, not a failed
transaction; the user is directed to the explorer and retries remain blocked.
Once `eth_sendTransaction` has been invoked, only the standard EIP-1193 `4001`
rejection code is treated as an explicit cancellation. A transport error,
non-standard rejection, malformed result, or missing hash is indeterminate: the
wallet may already have broadcast the intent, so the panel locks retries and
requires wallet-activity reconciliation even when no explorer link is available.
Wallet account or chain changes invalidate prepared state. If context changes
while a transaction may be pending, the panel keeps its explorer warning and
does not infer a safe retry.

Immediately before the wallet send call, the panel durably records the exact
wallet, pool, action subtype, target, calldata, zero value, approval amount or
full quote bounds, and timing identity. A returned hash is added to that same
validated intent. Malformed, unreadable, duplicated, or over-capacity browser
state blocks trading instead of being discarded. On reload, a known hash is
automatically reconciled through the independent canonical confirmation path;
the lock clears only after matching success or a two-block canonical revert.
A no-hash indeterminate submission remains manual wallet-activity recovery.
Each confirmation RPC call is bounded by both a per-request timeout and the
overall receipt deadline/cancellation signal, so an unresponsive endpoint
cannot leave the panel awaiting one promise forever.

The independent RPC materially narrows false-confirmation risk but is not a
finality oracle: two L2 blocks can still reorg, the public endpoint can be
unavailable or compromised, and a malicious wallet remains in control of what
it signs and whether it returns the real hash. The exact on-chain deadline and
direct-RPC transaction binding prevent a delayed or substituted call from being
reported as this trade; an indeterminate submission still requires manual
wallet/explorer reconciliation before retry.

Trading remains disabled until an independently audited Robinhood production
deployment is entered in the public manifest environment variables. No test or
fixture path can opt into wallet mutations.
