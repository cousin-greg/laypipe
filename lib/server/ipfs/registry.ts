import { HttpError } from "../auth/http";
import {
  DATABASE_WRITE_TIMEOUT_MS,
  databaseFetchOptions,
  getDatabase,
  type DbTransactionQuery,
} from "../db/neon";
import type { PromotionIdentity, PromotionPin } from "./promotion";
import type { Address } from "../../web3/types";

export const RECORD_COMPLETED_PROMOTION_SQL = `/* ipfs:record-completed-promotion */
INSERT INTO ipfs_promotions (
  promotion_id, stage_file_id, pin_digest, wallet_address, file_sha256,
  image_cid, metadata_cid, image_file_id, metadata_file_id,
  image_size, metadata_size, image_mime_type, metadata_mime_type,
  status, completed_at
) VALUES (
  $1::text, $2::uuid, $3::text, $4::evm_address, $5::text,
  $6::text, $7::text, $8::uuid, $9::uuid,
  $10::integer, $11::integer, $12::text, $13::text,
  'completed', to_timestamp($14::double precision / 1000.0)
)
ON CONFLICT (promotion_id) DO UPDATE
SET promotion_id = ipfs_promotions.promotion_id
WHERE ipfs_promotions.stage_file_id = EXCLUDED.stage_file_id
  AND ipfs_promotions.pin_digest = EXCLUDED.pin_digest
  AND ipfs_promotions.wallet_address = EXCLUDED.wallet_address
  AND ipfs_promotions.file_sha256 = EXCLUDED.file_sha256
  AND ipfs_promotions.image_cid = EXCLUDED.image_cid
  AND ipfs_promotions.metadata_cid = EXCLUDED.metadata_cid
  AND ipfs_promotions.image_file_id = EXCLUDED.image_file_id
  AND ipfs_promotions.metadata_file_id = EXCLUDED.metadata_file_id
  AND ipfs_promotions.image_size = EXCLUDED.image_size
  AND ipfs_promotions.metadata_size = EXCLUDED.metadata_size
  AND ipfs_promotions.image_mime_type = EXCLUDED.image_mime_type
  AND ipfs_promotions.metadata_mime_type = EXCLUDED.metadata_mime_type
  AND ipfs_promotions.status = 'completed'
RETURNING promotion_id`;

export const PROMOTION_REGISTRY_READY_SQL = `/* ipfs:promotion-registry-ready */
SELECT 1::integer AS ready FROM ipfs_promotions LIMIT 0`;

interface PromotionRegistryRow {
  promotion_id: unknown;
  [key: string]: unknown;
}

export interface CompletedPromotionRecord extends PromotionIdentity {
  wallet: Address;
  fileSha256: string;
  image: PromotionPin;
  metadata: PromotionPin;
  completedAt: number;
}

export async function requirePromotionRegistryDatabase() {
  try {
    return await getDatabase();
  } catch {
    throw new HttpError(
      503,
      "PROMOTION_REGISTRY_UNAVAILABLE",
      "Artwork publishing is unavailable.",
    );
  }
}

export async function recordCompletedPromotion(
  database: DbTransactionQuery,
  record: CompletedPromotionRecord,
) {
  try {
    const rows = await database.query<PromotionRegistryRow>(
      RECORD_COMPLETED_PROMOTION_SQL,
      [
        record.promotionId,
        record.stageFileId,
        record.pinDigest,
        record.wallet.toLowerCase(),
        record.fileSha256,
        record.image.cid,
        record.metadata.cid,
        record.image.id,
        record.metadata.id,
        record.image.size,
        record.metadata.size,
        record.image.mimeType,
        record.metadata.mimeType,
        record.completedAt,
      ],
      databaseFetchOptions(DATABASE_WRITE_TIMEOUT_MS),
    );
    if (rows.length !== 1 || rows[0]?.promotion_id !== record.promotionId) {
      throw new Error("promotion registry identity mismatch");
    }
  } catch {
    throw new HttpError(
      503,
      "PROMOTION_REGISTRY_UNAVAILABLE",
      "Artwork publishing could not be finalized. Retry the same request.",
    );
  }
}

export async function assertPromotionRegistryReady(database: DbTransactionQuery) {
  try {
    await database.query(
      PROMOTION_REGISTRY_READY_SQL,
      [],
      databaseFetchOptions(DATABASE_WRITE_TIMEOUT_MS),
    );
  } catch {
    throw new HttpError(
      503,
      "PROMOTION_REGISTRY_UNAVAILABLE",
      "Artwork publishing is unavailable.",
    );
  }
}
