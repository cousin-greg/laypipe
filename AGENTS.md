# LayPipe project rules

## Brand and interface

- PP Mori is the default interface typeface for body copy, navigation, controls,
  cards, tables, labels, and documentation.
- Dragon is reserved for large display headlines and selected expressive
  wordmarks. Do not use Dragon for dense copy or routine navigation.
- Do not use background grids, graph-paper patterns, or decorative square
  overlays. Prefer clean warm daylight surfaces in light mode and restrained
  Robinhood-green outdoor tones in dark mode.
- `public/brand/pipedog.png` is the canonical PIPEDOG artwork from
  `pipedog.xyz`. Preserve the dog exactly; never redraw, beautify, smooth,
  cartoonize, or reinterpret it with image generation. Composite the exact
  cutout with separately generated supporting scenery when needed.
- PipeDog is inherited net art, not a blank mascot. Preserve its documented
  lineage from Balltze/Cheems through the exact Domge PNG and later detective
  composite. Record source URLs, dates, dimensions, file hashes, and whether a
  link is confirmed, probable, or unresolved.
- Final PipeDogs use deterministic found-image layers around the unchanged dog.
  Keep crude cut edges, mismatched flash, compression, and recognizable marks
  on real objects. Do not strip cigarette-package logos or replace them with
  generic boxes. Generated images may explore composition, but they are not
  provenance masters or replacements for the canonical dog layer.

## Protocol

- Canonical PIPEDOG:
  `0x5Cb6F181081301b44905F3ae15419112ecaBd8A6` on Robinhood Chain.
- LayPipe is one fixed-supply coin, not a public launchpad. `LAYPIPE` has an
  exact supply of 1,000,000,000 tokens and a linked automatic PipeDogs ERC-721
  mirror capped at 10,000 NFTs. Every whole 100,000 LAYPIPE held by an ordinary
  wallet equals one PipeDog and one reward unit; smaller balances earn nothing.
- PIPEDOG is the quote, payment, paired, reward, and fee asset for the one
  official PIPEDOG/LAYPIPE market. Trading paths must not use native ETH or
  WETH as the quote.
- The singleton Uniswap v4 hook charges 1% of the PIPEDOG side of each official
  pool buy or sell. 100% is assigned to automatic PipeDog holders by whole NFT
  count. There is no developer, creator, treasury, self-burn, or operations
  share.
- Treat PIPEDOG as an exact-transfer, 18-decimal ERC-20 without permit. Wallet
  flows require an exact, single-use allowance before a buy or sell. Never ask
  for an unlimited approval.
- The market is a permanent one-sided Uniswap v4 bonding pool. The starting
  tick and launch depth need explicit PIPEDOG-denominated calibration. Do not
  silently reuse ETH-denominated defaults.
- Never broadcast a contract deployment without explicit authorization and an
  independent audit.

## Workspace

- Active work happens only in `C:\Users\cousi\Projects\LayPipe`.
- `C:\Users\cousi\OneDrive\Documents\Laypipedotfun` is an untouched archive of
  the pre-pivot worktree. Do not edit, build, or install dependencies there.

## Hosting and verification

- Vercel is the only deployment target. Do not add a Sites or Cloudflare Worker
  deployment binding.
- Before pushing interface work, run `npm test`, `npm run lint`, and
  `npx tsc --noEmit`.
- Before any protocol release candidate, run the complete Foundry suite plus
  source-fidelity, ABI-generation, and no-broadcast deployment checks described
  in `contracts/README.md`.
