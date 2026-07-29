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

## Protocol

- Canonical PIPEDOG:
  `0x5Cb6F181081301b44905F3ae15419112ecaBd8A6` on Robinhood Chain.
- PIPEDOG is the quote, payment, fee, and paired asset for LayPipe launches.
  Trading paths must not use native ETH or WETH as the launch-token quote.
- Treat PIPEDOG as an exact-transfer, 18-decimal ERC-20 without permit. Wallet
  flows require an exact, single-use allowance before launch or buy. Never ask
  for an unlimited approval to the upgradeable factory.
- Treat each launch as a permanent one-sided Uniswap v4 bonding pool unless a
  separately audited graduation state machine is designed before mainnet.
- Start tick and launch sizing need explicit PIPEDOG-denominated economic
  calibration. Do not silently reuse ETH-denominated defaults.
- Never broadcast a contract deployment without explicit authorization and an
  independent audit.

## Hosting and verification

- Vercel is the only deployment target. Do not add a Sites or Cloudflare Worker
  deployment binding.
- Before pushing interface work, run `npm test`, `npm run lint`, and
  `npx tsc --noEmit`.
- Before any protocol release candidate, run the complete Foundry suite plus
  source-fidelity, ABI-generation, and no-broadcast deployment checks described
  in `contracts/README.md`.
