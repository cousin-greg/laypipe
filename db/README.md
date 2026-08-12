# LayPipe read model

Robinhood Chain is authoritative. This database can be deleted and rebuilt
from the deployment block; it never authorizes a wallet action or changes
protocol state.

## Runtime contract

- `chain_blocks` stores canonical block identities.
- `chain_events` stores raw logs and is uniquely keyed by
  `(chain_id, transaction_hash, log_index)`.
- Source-derived rows reference their raw event with `ON DELETE CASCADE`.
- `token_balances` is a view over immutable transfers, so rollback never needs
  to repair a mutable balance cache.
- EVM unsigned values use `numeric(78,0)` and cross the JavaScript boundary as
  base-10 strings or `bigint`, never `number`.
- An immutable-row trigger makes identical retries safe and rejects a retry
  whose data differs under the same block or log identity.
- Cursor advancement is a database compare-and-swap performed in the same
  serializable transaction as blocks, logs, and projections.

## Dependencies and migration

Required runtime package: `@neondatabase/serverless`. The repository uses the
driver directly and keeps the migration source as reviewed SQL; it does not
require an ORM or Drizzle.

Required development packages: `dotenv-cli` and `tsx`.
Standalone scripts do not load `.env.local`; run the migration with an ignored
environment file explicitly:

```powershell
npx dotenv -e .env.local -- npx tsx scripts/indexer/migrate.ts
```

`DATABASE_URL` is server-only and required lazily when the data layer is first
used. A missing or malformed value fails closed without breaking a frontend-only
`next build`.

## Reorg procedure

1. Load a bounded newest-first window with `loadRecentStoredBlocks`.
2. Compare each height with archive RPC using `findCommonAncestor`.
3. If no common ancestor exists within the bound, stop and increase the audit
   window; never guess.
4. Call `rollbackChainTo` with the exact stored ancestor height and hash.
5. Cascades delete later raw events and every derived row atomically; cursors
   move back to the ancestor.
6. Replay forward with `ingestCanonicalBatch`.

The rollback function validates the ancestor hash before deleting anything.
It cannot roll back to a caller-supplied height whose stored hash differs.
