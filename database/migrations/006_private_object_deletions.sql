-- Deletion intents survive request failures and worker restarts. Never reuse object keys.
CREATE TABLE file_object_deletions (
  object_key text PRIMARY KEY CHECK (length(object_key) BETWEEN 1 AND 512),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  claim_id uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX file_object_deletions_due_idx ON file_object_deletions(next_attempt_at)
  WHERE claimed_until IS NULL;
-- Existing logically deleted records may still have objects in the private bucket.
INSERT INTO file_object_deletions(object_key)
SELECT object_key FROM files WHERE state='deleted' ON CONFLICT DO NOTHING;
