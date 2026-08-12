# laypipe.fun

A sunshine-styled Robinhood Chain launch board and contract implementation
where PIPEDOG is the quote, payment, fee, and paired asset for every launch.
Native ETH is used for network gas only.

## Product surface

- latest-token marquee and rotating fixture Hot/Largest/Newest/Mover feature;
  live mode exposes exact indexed Most traded/Newest/Biggest mover views and
  exact PIPEDOG-volume/gainer sorting; market cap remains unavailable until a
  trusted PIPEDOG-denominated supply valuation is implemented;
- responsive 1–5-column Board with card/table views and URL-backed filters;
- Board, My Tokens, Rewards, Tokenomics, Docs, Launch, and token-detail routes;
- persistent light/dark themes, injected-wallet connection, and Robinhood
  Chain switching;
- local PP Mori and Dragon webfonts;
- canonical PIPEDOG artwork composited with separately generated pipe and
  furnace scenery, plus the favicon and social card;
- fixture and live market adapters behind an explicit fail-closed deployment
  mode, signed keyset pagination, and a reorg-safe canonical indexer;
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
The shorter owner/operator sequence is in
[LAUNCH_CHECKLIST.md](./LAUNCH_CHECKLIST.md), and the external-review boundary
is in [contracts/AUDIT_HANDOFF.md](./contracts/AUDIT_HANDOFF.md).

PIPEDOG has no native `burn()` method. The platform’s 25% sink lane sends
PIPEDOG directly to `0x000000000000000000000000000000000000dEaD`; this removes
tokens from practical circulation without reducing ERC-20 `totalSupply`. The
other protocol lanes route 25% directly to treasury and 50% to operations.

PIPEDOG does not support permit. A live launch or buy must request only the
exact ERC-20 allowance needed for that action, never an unlimited approval.

## Local development

Requires Node.js `24.x`, matching the pinned Vercel runtime.

```bash
npm install
npm run dev
npm test
npm run lint
npx tsc --noEmit
```

Production is hosted on Vercel. The repository intentionally has no Sites or
Cloudflare Worker deployment binding. Vercel runs the standard Next.js build;
GitHub's `Release gates` workflow adds tests, lint, type-checking, a real
PostgreSQL rehearsal, dependency audit, and local protocol invariants.

The Board currently uses clearly marked fixture data. Keep
`LAYPIPE_MARKET_MODE=fixture` until the database migration, canonical backfill,
audited deployment manifest, readiness checks, and live Preview rehearsal are
all green. `live` selects the Neon-backed API explicitly and never falls back
to fixture prices when the database or indexer is unavailable.

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
