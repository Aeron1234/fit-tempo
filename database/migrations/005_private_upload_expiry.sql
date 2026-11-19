-- Phase 07: durable expiration for direct-upload grants and abandoned pending files.
ALTER TABLE files ADD COLUMN pending_expires_at timestamptz;
-- Pre-Phase-07 pending rows have no valid grant; make them immediately eligible for cleanup.
UPDATE files SET pending_expires_at = now() WHERE state = 'pending';
ALTER TABLE files ADD CONSTRAINT files_pending_expiry_check
  CHECK (state <> 'pending' OR pending_expires_at IS NOT NULL);
CREATE INDEX files_pending_expiry_idx ON files(pending_expires_at, id)
  WHERE state = 'pending';
