# Security and known limitations

## Deployment status

These contracts are unaudited and not deployed. Passing tests and a successful
fork simulation are not substitutes for an independent audit.

## Dividend mode is intentionally closed

The carried-forward dividend distributor uses open enrollment. Its payout
denominator covers enrolled balances, but the contract cannot prove that the
submitted holder set is complete. An incomplete round could therefore
over-reward enrolled holders.

For this reason:

- `LaypipeFactory.setDividendLaunchEnabled(true)` always reverts with
  `DividendModeUnderReview`;
- the deployment script does not deploy or wire a distributor;
- the distributor source and ABI remain research/parity artifacts only.

An audited complete-holder or cryptographic-proof design is required before a
future UUPS factory implementation may expose new dividend launches.

## PIPEDOG is sequestered, not supply-burned

PIPEDOG has no callable `burn()` in the target path. Bought tokens sent to
`0xdead` remain included in `totalSupply`. Any UI, indexer, or marketing copy
must report `pipedogSequestered`, sink balance, or circulating removal rather
than claiming that total supply decreased.

## Public market-order MEV

Self-burns and platform buys intentionally execute without a price oracle or
minimum output. Moving the price upward is part of the mechanism, but public
orders can be sandwiched. Per-call caps, one call per lane/pool per block, and
keeper bounties bound and distribute this exposure; they do not eliminate it.
Caps should be reviewed against live liquidity before deployment and monitored
afterward.

## Administrative trust

- Factory owner: may upgrade the launcher for future launches, change launch
  fee/config enablement, rotate infrastructure, and recover assets held by the
  factory address itself. Native recovery goes to the configured treasury and
  ERC20 recovery goes to the owner; the recovery function cannot transfer
  PoolManager liquidity, hook claims, creator tabs, or token-holder balances.
  Existing token bytecode, pool fee config, and the non-upgradeable
  liquidity-lock hook remain separate.
- Hook owner: may rotate only the platform treasury destination. Creator
  balances and fee-stream ownership remain creator-controlled.
- Revenue-router owner: may pause buy lanes, rotate treasury/operations
  destinations, tune order caps, and migrate platform-owned ETH to a successor.
- Creator: may claim or transfer that pool's creator fee stream.

The deployment script uses two-step ownership and leaves launch disabled.
Until `FINAL_OWNER` accepts, the deployment key remains the current owner. Plan
and execute acceptance promptly; do not fund or enable the system beforehand.

The router's 25/25/50 constants govern normal allocation, but owner migration
can move all remaining ETH to a successor. Treat the split as an
administrator-trusted operating policy rather than an irrevocable custody
guarantee.

Hook rotation automatically disables launches and clears old-hook-bound helper
contracts. Treasury changes require launch to be paused and the hook and
factory destinations to be aligned before re-enabling.

## Source-parity boundary

The live LetsCash hook, token, dividend distributor, and an earlier self-burner
have verified MIT source. The active factory implementation, active
self-burner, and 25/25/50 revenue splitter do not. Their Laypipe counterparts
are clean-room compatibility implementations based on public ABI, chain reads,
receipts/events, and first-party API behavior; they are not claimed to be
source-identical.

Re-run the reference fetch, source-fidelity check, live preflight, clean build,
full tests, and deployment simulation immediately before an audit handoff.

## Secrets

Keep the deployment key only in the ignored `contracts/.env`. Never commit
`.env`, broadcast/cache artifacts, keystores, mnemonic phrases, or Safe signing
material.
