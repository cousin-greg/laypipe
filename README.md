# laypipe.fun

A sunshine-styled Robinhood Chain launch board and contract implementation
where PIPEDOG is the quote, payment, fee, and paired asset for every launch.
Native ETH is used for network gas only.

## Product surface

- latest-token marquee and rotating fixture Hot/Largest/Newest/Mover feature;
  live mode publishes reorg-safe global Most traded/Newest/Biggest mover
  leaders while its keyset-paginated Board remains newest-first. PIPEDOG
  volume and percentage-change displays stay exact; market cap remains
  unavailable until a trusted PIPEDOG-denominated supply valuation is
  implemented;
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
configured release manifest, readiness checks, and live Preview rehearsal are
all green. `live` selects the Neon-backed API explicitly and never falls back
to fixture prices when the database or indexer is unavailable. Launch, trade,
and creator-claim transactions remain inert unless
`NEXT_PUBLIC_LAYPIPE_WALLET_MUTATIONS_ENABLED=true` is compiled into the build.

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

## Operator configuration preflight

Every `npm run build` runs the secret-safe configuration preflight first. With
no deployment profile or kill switches configured, the authoritative prebuild
defaults to the safe fixture state. Explicit local prechecks must supply all
four switches. Select the staged state in Vercel with
`LAYPIPE_CONFIG_PROFILE`:

```text
npm run verify:production-config -- safe-fixture
npm run verify:production-config -- preview-indexer
npm run verify:production-config -- preview-readonly
npm run verify:production-config -- preview-mutations
npm run verify:production-config -- production-indexer
npm run verify:production-config -- production-readonly
npm run verify:production-config -- production-mutations
```

Indexer profiles ingest while the Board remains a fixture. Read-only profiles
serve live Board data but keep IPFS and browser wallet mutations off. Mutation
profiles alone enable pinning and wallet transactions. Staged profiles require
the complete configured contract-release manifest and the infrastructure
appropriate to their tier. The contract manifest's source commit identifies the
separately reviewed protocol candidate. In an actual staged Vercel build,
server-only `LAYPIPE_APP_SOURCE_COMMIT` independently binds the application
checkout to `VERCEL_GIT_COMMIT_SHA`.

`vercel env run -e preview -- npm run verify:production-config --
preview-readonly` is only a local precheck because local and ambient variables
can override downloaded values. The actual Vercel build's passing `prebuild`
output is the authoritative static configuration evidence. It does not call
providers, apply migrations, prove credentials work, or prove an independent
audit. Complete the provider smoke tests in [PRODUCTION.md](./PRODUCTION.md).

## Key references

- [LetsCash contract documentation](https://www.letscash.fun/docs)
- [PIPEDOG](https://pipedog.xyz)
- [PIPEDOG on Robinhood Chain](https://robinhoodchain.blockscout.com/token/0x5Cb6F181081301b44905F3ae15419112ecaBd8A6)
