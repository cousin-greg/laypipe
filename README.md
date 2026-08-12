# laypipe.fun

A sunshine-styled Robinhood Chain launch board and contract implementation
where PIPEDOG is the quote, payment, fee, and paired asset for every launch.
Native ETH is used for network gas only.

## Product surface

- latest-token marquee and rotating Hot/Largest/Newest/Mover feature;
- responsive 1–5-column Board with card/table views and URL-backed filters;
- Board, My Tokens, Rewards, Tokenomics, Docs, Launch, and token-detail routes;
- persistent light/dark themes, injected-wallet connection, and Robinhood
  Chain switching;
- local PP Mori and Dragon webfonts;
- canonical PIPEDOG artwork composited with separately generated pipe and
  furnace scenery, plus the favicon and social card;
- explicit demo-data adapter with typed seams for the future live indexer;
- Foundry factory, permanent one-sided v4 pool, token, self-burner, and direct
  25/25/50 PIPEDOG revenue router, plus deployment preflight, fork tests,
  invariants, and committed ABIs under `contracts/`.

The public product is intentionally a preview. Demo coins are labeled
throughout, transaction controls remain disabled, and no LayPipe contract is
deployed or audited. The PIPEDOG-denominated curve parameters are not
production-calibrated. Read [contracts/README.md](./contracts/README.md) and
[contracts/SECURITY.md](./contracts/SECURITY.md) before any test deployment.
The infrastructure, account, metadata, indexing, and staged-release gates are
tracked in [PRODUCTION.md](./PRODUCTION.md).

PIPEDOG has no native `burn()` method. The platform’s 25% sink lane sends
PIPEDOG directly to `0x000000000000000000000000000000000000dEaD`; this removes
tokens from practical circulation without reducing ERC-20 `totalSupply`. The
other protocol lanes route 25% directly to treasury and 50% to operations.

PIPEDOG does not support permit. A live launch or buy must request only the
exact ERC-20 allowance needed for that action, never an unlimited approval.

## Local development

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
npm test
npm run lint
npx tsc --noEmit
```

Production is hosted on Vercel. The repository intentionally has no Sites or
Cloudflare Worker deployment binding; the standard Next.js scripts are the
single build path used locally, in CI, and by Vercel.

The Board currently uses clearly marked fixture data. Switch
`demoMarketAdapter` to `createApiMarketAdapter` only after the event indexer and
reviewed deployment addresses are available.

## Contract verification

From `contracts/`, install the pinned Foundry dependencies and run the complete
fork-backed suite:

```powershell
.\scripts\install-deps.ps1
forge clean
forge build
forge test -vv
node scripts\check-source-fidelity.mjs
node scripts\generate-abis.mjs
```

Do not add `--broadcast` to the deployment script without explicit deployment
authorization and an independent contract audit.

## Key references

- [LetsCash contract documentation](https://www.letscash.fun/docs)
- [PIPEDOG](https://pipedog.xyz)
- [PIPEDOG on Robinhood Chain](https://robinhoodchain.blockscout.com/token/0x5Cb6F181081301b44905F3ae15419112ecaBd8A6)
