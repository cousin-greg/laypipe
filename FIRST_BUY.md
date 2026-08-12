# LayPipe launch first buys

The optional launch first buy spends canonical PIPEDOG only:
`0x5Cb6F181081301b44905F3ae15419112ecaBd8A6`. Native ETH is gas only.
The factory pulls exactly `launchFee + firstBuyIn`; the interface never grants
an unlimited approval.

## Authoritative quote path

`LaypipeFactory` does not expose a quoter. A launch also creates its token and
pool inside the same transaction, so an already-created pool cannot be used to
quote the first swap. The browser therefore mirrors the exact integer path used
by the configured release candidate:

1. Read the launch config, fee, canonical quote-token binding, balance, and
   exact allowance from one fully verified deployment snapshot.
2. Derive the deterministic one-sided liquidity from `supply`, `tickSpacing`,
   and `startTick` using the same TickMath and LiquidityAmounts rounding as the
   factory.
3. Apply the hook's first-buy `baseFeeRate` with floor rounding, then mirror the
   single Uniswap v4 exact-input swap step to obtain token output.
4. After the exact `launchFee + firstBuyIn` allowance exists, prove that output
   against the full factory call at the same pinned block. A call with
   `minOut = expectedOutput` must return the mined token, while the identical
   call with `minOut = expectedOutput + 1` must revert with exactly
   `FirstBuySlippage()`.
5. Apply the creator-selected 0.5%-5% slippage bound. The resulting nonzero
   `firstBuyMinOut` is encoded in the launch calldata.

Immediately before the wallet prompt, LayPipe repeats the configured deployment,
config, canonical PIPEDOG balance, and exact-allowance preflight at one block,
simulates the actual protected calldata at that block, verifies the returned
predicted token, and then rereads wallet chain, account, and head. The exact
calldata and mined-token identity are saved before `eth_sendTransaction`; the
canonical receipt must bind to that saved intent.

## Freshness and the factory limitation

The quote has a 30-second browser TTL and a 600-Robinhood-block client drift
cap. Both are checked again immediately before invoking the wallet. These are
pre-submission intent-freshness rules, not an on-chain deadline.

The current `launch(TokenParams,uint256,uint256,uint256,bytes32)` ABI has no
deadline field. Once the wallet receives the request, the transaction can remain
valid beyond the browser TTL. The nonzero `firstBuyMinOut` still enforces the
execution-price floor on-chain, and the launch is atomic, but expiry after wallet
submission cannot be enforced without a separately audited factory upgrade.
The interface must never describe the client TTL or drift cap as an on-chain
deadline.

If the exact boundary proof, deployment snapshot, balance, allowance, account,
chain, protected simulation, quote identity, TTL, or drift check fails, the
wallet request is not invoked. A failed launch can leave the exact allowance in
place; the existing explicit allowance-clear recovery remains available.
