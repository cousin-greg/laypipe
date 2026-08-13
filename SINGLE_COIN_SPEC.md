# LayPipe single-coin specification

Status: product direction locked on 2026-08-13. This document replaces the
permissionless multi-launch product assumptions for the local `codex/single-coin`
workstream. It does not authorize deployment.

## Fixed product constants

| Parameter | Value |
| --- | ---: |
| ERC-20 name | LayPipe |
| ERC-20 symbol | LAYPIPE |
| Decimals | 18 |
| Total fungible supply | 1,000,000,000 LAYPIPE |
| Maximum mirrored PipeDogs | 10,000 |
| Fungible units per PipeDog | 100,000 LAYPIPE |
| Quote, pair, and fee asset | Canonical PIPEDOG |
| Trade fee | 1% of PIPEDOG moved |
| Holder reward share | 100% of the trade fee |
| Developer or treasury fee | 0% |

The conversion is exact:

```text
1,000,000,000 LAYPIPE / 10,000 PipeDogs = 100,000 LAYPIPE per PipeDog
```

Examples:

- 99,999.999 LAYPIPE: zero PipeDogs and zero reward units.
- 100,000 LAYPIPE: one PipeDog and one reward unit.
- 250,000 LAYPIPE: two PipeDogs, two reward units, and 50,000 LAYPIPE of
  progress toward a third.
- 1,000,000,000 LAYPIPE: 10,000 PipeDogs and 10,000 reward units.

## Automatic NFT behavior

LAYPIPE uses a linked ERC-20 base and ERC-721 mirror following the ERC-7631
model. A wallet's mirrored NFT count is:

```text
floor(erc20Balance / 100,000 LAYPIPE)
```

Crossing a whole-unit threshold upward assigns PipeDog NFTs automatically.
Crossing downward returns the corresponding NFT IDs to the protocol's NFT bank
for later reassignment. Fractional LAYPIPE remains freely transferable.

To keep automatic ERC-721 synchronization bounded, one ordinary transfer may
cross at most 20 whole-unit thresholds (2,000,000 LAYPIPE). Larger buys, sells,
or transfers must be split. Transfers solely between excluded protocol custody
addresses may move the full launch inventory without creating NFTs.

The pool, swap router, reward vault, launch controller, zero address, and other
protocol custody addresses are NFT-sync and reward excluded. Their balances do
not create PipeDogs or dilute holder rewards.

## PIPEDOG fee flow

There is exactly one permanent PIPEDOG/LAYPIPE Uniswap v4 pool. Every buy and
sell through this official pool charges a 1% fee on the PIPEDOG side. The
complete fee is deposited into the PipeDog reward vault. There is no developer,
creator, treasury,
sequestration, self-burn, or operations lane.

Uniswap v4 represents each collected fee as a PoolManager claim. During that
same swap callback, the singleton hook mints the exact PIPEDOG claim directly to
the reward vault and updates its accumulator. Reward weight is therefore
sampled at trade time. When a holder claims, the vault redeems the necessary
PoolManager claim into canonical PIPEDOG and transfers it to that holder.
There is no sweep-timing window and no intermediary may redirect or take a
share of the fee.

The vault must never loop over holders. It maintains a cumulative PIPEDOG per
eligible reward unit accumulator. Before any wallet's whole-unit count changes,
the token/vault settles that wallet against the current accumulator; after the
change it records the new unit count. This preserves rewards earned before a
sale or transfer and prevents new units from claiming earlier fees.

Required accounting properties:

- A wallet below one full unit accrues nothing.
- A wallet with `n` mirrored PipeDogs receives `n / totalEligibleUnits` of each
  distributable fee, subject only to integer rounding.
- Rounding dust remains conserved and backed in the vault; it is never
  overallocated or diverted.
- Claims are pull-based and paid only in canonical PIPEDOG.
- Buying, selling, transferring, minting, returning, and transferring an NFT
  cannot lose already accrued PIPEDOG.
- No reflection transfers, rebasing, fee-on-transfer LAYPIPE, holder loops, or
  per-trade push payments.

## Launch and trading

The website exposes one reviewed launch and one trading market. It is not a
general token launcher. The pool is a permanent one-sided Uniswap v4 bonding
pool paired only with canonical PIPEDOG; there is no automatic graduation or
migration phase.

The exact starting tick, seed allocation, initial PIPEDOG depth, and launch
timing remain calibration inputs. They are not implied by the total supply or
NFT conversion ratio.

The launcher seeds the largest representable one-sided v4 position. Any
LAYPIPE remainder must be proven smaller than one liquidity quantum and is
returned to the still-excluded initial supply owner before that owner becomes
an ordinary holder. The launcher retains no LAYPIPE, total supply remains
exactly one billion, and all 10,000 automatic PipeDog units remain reachable.

## Website surface

Primary navigation and pages become:

- **Home / Trade:** singleton PIPEDOG/LAYPIPE buy and sell, price, supply, and
  fee totals.
- **My PipeDogs:** wallet LAYPIPE balance, automatic NFT count, progress toward
  the next 100,000-token threshold, owned PipeDog cards, and traits.
- **Rewards:** claimable PIPEDOG, claimed history, total distributed, and claim
  action.
- **Collection:** the 10,000-piece trait set and provenance.
- **Docs:** the automatic conversion and 1% fee mechanics.

The public multi-token board, permissionless launch form, creator controls,
self-burn controls, market rankings, and generic token detail routes are not
part of this product.

## Art boundary

`public/brand/pipedog.png` remains the exact canonical PIPEDOG reference and is
never redrawn or regenerated. PipeDog NFTs use a separately authored layer set
for backgrounds, clothing, hats, eyes, mouths, and props, with deterministic
trait assembly and a committed provenance manifest.

## Worktree boundary

New single-coin implementation work happens only in the local checkout:

```text
C:\Users\cousi\Projects\LayPipe
```

The former OneDrive checkout is an untouched archive of the pre-pivot working
state. No deployment, transaction broadcast, commit, or push is implied by this
specification.
