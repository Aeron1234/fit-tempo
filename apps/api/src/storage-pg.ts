import type { Pool } from 'pg';
import type { ImageMime, MetadataRepository, StorageMetadata } from './storage/index.js';

type FileRow = {
  id: string; user_id: string; kind: StorageMetadata['kind']; object_key: string;
  state: StorageMetadata['state']; pending_expires_at: Date | null; mime_type: ImageMime;
};
const map = (row: FileRow): StorageMetadata => ({
  id: row.id, userId: row.user_id, kind: row.kind, objectKey: row.object_key,
  state: row.state, expiresAt: row.pending_expires_at, mimeType: row.mime_type,
});

/** Every lookup and state transition is scoped by the verified session user. */
export function createPgFileMetadata(db: Pool): MetadataRepository {
  const columns = 'id,user_id,kind,object_key,state,pending_expires_at,mime_type';
  async function transitionAndQueue(sql: string, args: unknown[]) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ object_key: string }>(sql, args);
      if (result.rows[0]) await client.query(`INSERT INTO file_object_deletions(object_key)
        VALUES ($1) ON CONFLICT DO NOTHING`, [result.rows[0].object_key]);
      await client.query('COMMIT');
      return result.rowCount === 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  return {
    async createPending(row) {
      await db.query(`INSERT INTO files(${columns},byte_size) VALUES ($1,$2,$3,$4,'pending',$5,$6,$7)`,
        [row.id, row.userId, row.kind, row.objectKey, row.expiresAt, row.mimeType, row.byteSize]);
    },
    async findOwned(userId, id) {
      const found = await db.query<FileRow>(`SELECT ${columns} FROM files WHERE user_id=$1 AND id=$2`, [userId, id]);
      return found.rows[0] ? map(found.rows[0]) : null;
    },
    async finalizeIfPending(userId, id, updated) {
      return transitionAndQueue(`WITH pending AS (
          SELECT id,object_key FROM files WHERE user_id=$1 AND id=$2 AND state='pending'
            AND pending_expires_at>now() FOR UPDATE
        ) UPDATE files f SET state='ready',object_key=$3,mime_type=$4,byte_size=$5,
        pending_expires_at=NULL,updated_at=now() FROM pending p WHERE f.id=p.id
        RETURNING p.object_key`,
        [userId, id, updated.objectKey, updated.mimeType, updated.byteSize]);
    },
    async markDeleted(userId, id) {
      return transitionAndQueue(`UPDATE files SET state='deleted',updated_at=now()
        WHERE user_id=$1 AND id=$2 AND state<>'deleted' RETURNING object_key`, [userId, id]);
    },
    async markExpiredPending(userId, id, now) {
      return transitionAndQueue(`UPDATE files SET state='deleted',updated_at=now()
        WHERE user_id=$1 AND id=$2 AND state='pending' AND pending_expires_at<=$3 RETURNING object_key`, [userId, id, now]);
    },
    async listExpiredPending(now, limit) {
      const result = await db.query<FileRow>(`SELECT ${columns} FROM files
        WHERE state='pending' AND pending_expires_at<=$1 ORDER BY pending_expires_at,id LIMIT $2`, [now, limit]);
      return result.rows.map(map);
    },
    async enqueueDeletion(objectKey) {
      await db.query(`INSERT INTO file_object_deletions(object_key) VALUES ($1) ON CONFLICT DO NOTHING`, [objectKey]);
    },
    async claimDeletions(limit) {
      const result = await db.query<{ object_key: string; attempts: number; claim_id: string }>(`WITH due AS (
        SELECT object_key FROM file_object_deletions WHERE next_attempt_at<=now()
          AND (claimed_until IS NULL OR claimed_until<now())
        ORDER BY next_attempt_at,object_key FOR UPDATE SKIP LOCKED LIMIT $1
      ) UPDATE file_object_deletions d SET claimed_until=now()+interval '30 seconds', claim_id=gen_random_uuid()
        FROM due WHERE d.object_key=due.object_key RETURNING d.object_key,d.attempts,d.claim_id`, [limit]);
      return result.rows.map(row => ({ objectKey: row.object_key, attempts: row.attempts, claimId: row.claim_id }));
    },
    async completeDeletion(objectKey, claimId) {
      await db.query('DELETE FROM file_object_deletions WHERE object_key=$1 AND claim_id=$2', [objectKey, claimId]);
    },
    async retryDeletion(objectKey, claimId, attempts) {
      await db.query(`UPDATE file_object_deletions SET attempts=$3,claimed_until=NULL,claim_id=NULL,
        next_attempt_at=now()+make_interval(secs => LEAST(3600, 5 * power(2, LEAST($3, 9)))::int)
        WHERE object_key=$1 AND claim_id=$2`, [objectKey, claimId, attempts]);
    },
  };
}
