# laypipe.fun

A sunshine-styled Robinhood Chain launchpad concept built around public
PIPEDOG buybacks and burns.

## Product surface

- live PIPEDOG market data from Blockscout and DexScreener
- injected-wallet connection and Robinhood Chain switching
- creator-stream and self-burn launch preview
- responsive protocol-flow and tokenomics explainers
- official PIPEDOG imagery from `pipedog.xyz`
- contract adaptation notes under `contracts/`

The launch form is intentionally a preview. The PIPEDOG-targeted contracts must
be independently deployed, verified, and audited before the interface can
submit launch or burn transactions.

## Local development

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
npm test
```

## Key references

- [LetsCash contract documentation](https://www.letscash.fun/docs)
- [PIPEDOG](https://pipedog.xyz)
- [PIPEDOG on Robinhood Chain](https://robinhoodchain.blockscout.com/token/0x5Cb6F181081301b44905F3ae15419112ecaBd8A6)
