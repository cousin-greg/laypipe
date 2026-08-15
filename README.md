# laypipe.fun

An early-web Robinhood Chain preview for one fixed-supply LAYPIPE market,
automatic Lay Pipedogs, and periodic PIPEDOG holder rewards. The intended
official pool is native ETH/LAYPIPE. Its v4 hook accrues an ETH-side fee that a
permissionless reward cycle uses to purchase PIPEDOG for whole-NFT holders.

## Product surface

- one disabled single-market ETH/LAYPIPE trade preview;
- automatic Lay Pipedog ownership and reward-unit previews at each complete
  100,000 LAYPIPE balance threshold;
- My Lay Pipedogs, Rewards, Mechanics, Lore, and Docs routes;
- an early-web light theme, injected-wallet connection, and Robinhood Chain
  switching;
- local PP Mori webfonts;
- canonical PIPEDOG artwork preserved exactly in the interface, favicon, and
  social card;
- a source-linked lore timeline that distinguishes cultural ancestry from the
  exact PipeDog pixel lineage;
- fixture adapters behind an explicit fail-closed contract-preview mode.

The public product is intentionally a preview. Transaction controls remain
disabled, and no current singleton LayPipe system is deployed or audited. The
ETH-denominated curve and reward-cycle parameters are not production-calibrated.
Read [contracts/README.md](./contracts/README.md) and
[contracts/SECURITY.md](./contracts/SECURITY.md) before any test deployment.
The infrastructure, account, metadata, indexing, and staged-release gates are
tracked in [PRODUCTION.md](./PRODUCTION.md).
The shorter owner/operator sequence is in
[LAUNCH_CHECKLIST.md](./LAUNCH_CHECKLIST.md), and the external-review boundary
is in [contracts/AUDIT_HANDOFF.md](./contracts/AUDIT_HANDOFF.md).

The repository still contains the previous multi-launch implementation and its
indexer tests. Those contracts are not wired to this singleton preview and must
not be treated as the current launch plan or a production release candidate.

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
