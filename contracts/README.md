# laypipe.fun contract adaptation

The product design follows the verified LetsCash contracts on Robinhood Chain:

- launchpad factory: `0x5bd1Fbe78a78fe8236fa00CF48fbEBA74ae34661`
- Uniswap v4 hook: `0xEfe669814e5Eec33406Bd50ffa8331618D076aEc`
- self burner: `0x580C70D2234a579B2631593693c66caE3886A98E`
- revenue splitter: `0x6D3d822F6e625c59804F47cf2Cc1d53B8301016F`

The target protocol asset for this adaptation is PIPEDOG:

`0x5Cb6F181081301b44905F3ae15419112ecaBd8A6`

## Deployment boundary

The live LetsCash revenue splitter is already deployed around CASHCAT. A
frontend cannot safely redirect it. The laypipe deployment must use a freshly
deployed splitter configured with PIPEDOG, then connect that splitter to the new
factory/hook deployment.

Before mainnet:

1. Import the verified MIT-identified hook and associated sources from
   Blockscout into a dedicated Foundry repository.
2. Preserve the fixed-tax, locked-liquidity, self-burn, sweep, claim, and keeper
   behavior.
3. Replace only the protocol token configuration with `PIPEDOG`.
4. Add tests proving the burn lane buys PIPEDOG and sends it through an
   irreversible burn path.
5. Run independent audits and publish verified deployment addresses.

The website deliberately labels the contract flow as a preview until those
steps are complete.
