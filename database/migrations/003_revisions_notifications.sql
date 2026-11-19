-- Every writer in a user's scope locks its revision row before checking receipts/current revision.
CREATE TABLE schedule_revisions (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740990),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pantry_revisions (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740990),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE daily_tracking_status (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('nutrition','hydration','activity')),
  recorded_local_date date NOT NULL,
  recorded_time_zone text NOT NULL CHECK (length(recorded_time_zone) BETWEEN 1 AND 128),
  state text NOT NULL CHECK (state IN ('unrecorded','partial','complete')),
  entry_count integer NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
  confirmed_at timestamptz,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740990),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,category,recorded_local_date),
  CHECK ((state = 'complete') = (confirmed_at IS NOT NULL)),
  CHECK (state <> 'unrecorded' OR entry_count = 0),
  CHECK (state <> 'partial' OR entry_count > 0)
);
CREATE INDEX daily_tracking_user_date_idx ON daily_tracking_status(user_id,recorded_local_date,category);

-- Immutable commit summaries avoid replaying a later edited live row.
CREATE TABLE mutation_results (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_type text NOT NULL CHECK (operation_type IN ('accept_schedule','deduct_pantry','complete_day','reopen_day','complete_workout','log_meal')),
  response_schema_version smallint NOT NULL DEFAULT 1 CHECK (response_schema_version = 1),
  commit_summary jsonb NOT NULL CHECK (jsonb_typeof(commit_summary) = 'object' AND octet_length(commit_summary::text) <= 65536),
  committed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,operation_type,id)
);
CREATE TABLE operation_receipts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_type text NOT NULL CHECK (operation_type IN ('accept_schedule','deduct_pantry','complete_day','reopen_day','complete_workout','log_meal')),
  client_operation_id uuid NOT NULL,
  digest_version smallint NOT NULL DEFAULT 1 CHECK (digest_version = 1),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  result_reference uuid NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,operation_type,client_operation_id),
  FOREIGN KEY(user_id,operation_type,result_reference) REFERENCES mutation_results(user_id,operation_type,id)
);
CREATE INDEX operation_receipts_user_result_idx ON operation_receipts(user_id,result_reference);

CREATE TABLE notification_preferences (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('workout_reminder','meal_reminder','hydration_reminder','weekly_summary','milestone')),
  enabled boolean NOT NULL DEFAULT false,
  preferred_local_time time,
  time_zone_policy text NOT NULL DEFAULT 'user' CHECK (time_zone_policy IN ('user','fixed')),
  fixed_time_zone text CHECK (length(fixed_time_zone) BETWEEN 1 AND 128),
  interval_minutes integer CHECK (interval_minutes BETWEEN 1 AND 10080),
  weekday smallint CHECK (weekday BETWEEN 0 AND 6),
  quiet_start time,
  quiet_end time,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740990),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,type),
  CHECK ((time_zone_policy = 'fixed') = (fixed_time_zone IS NOT NULL)),
  CHECK ((quiet_start IS NULL) = (quiet_end IS NULL)),
  UNIQUE(user_id,id)
);
CREATE TABLE notification_jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('workout_reminder','meal_reminder','hydration_reminder','weekly_summary','milestone')),
  occurrence_identity text NOT NULL CHECK (length(occurrence_identity) BETWEEN 1 AND 240),
  scheduled_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','sending','accepted','unknown','failed','cancelled','expired')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  retry_at timestamptz,
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  preference_revision bigint CHECK (preference_revision BETWEEN 0 AND 9007199254740990),
  schedule_revision bigint CHECK (schedule_revision BETWEEN 0 AND 9007199254740990),
  scheduled_workout_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(user_id,scheduled_workout_id) REFERENCES scheduled_workouts(user_id,id),
  UNIQUE(user_id,id),
  CHECK (expires_at > scheduled_at),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL) AND (lease_owner IS NULL) = (lease_token IS NULL)),
  CHECK (type <> 'workout_reminder' OR (schedule_revision IS NOT NULL AND scheduled_workout_id IS NOT NULL))
);
CREATE INDEX notification_jobs_user_status_idx ON notification_jobs(user_id,status,scheduled_at);
CREATE INDEX notification_jobs_due_idx ON notification_jobs(COALESCE(retry_at,scheduled_at),id) WHERE status IN ('pending','failed');
CREATE INDEX notification_jobs_workout_revision_idx ON notification_jobs(user_id,scheduled_workout_id,schedule_revision,status);
CREATE UNIQUE INDEX notification_jobs_other_occurrence_idx ON notification_jobs(user_id,type,occurrence_identity)
  WHERE type <> 'workout_reminder';
CREATE UNIQUE INDEX notification_jobs_workout_occurrence_idx ON notification_jobs(user_id,scheduled_workout_id,schedule_revision,type,occurrence_identity)
  WHERE type = 'workout_reminder';
CREATE TABLE notification_logs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id uuid,
  template_key text NOT NULL CHECK (length(template_key) BETWEEN 1 AND 120),
  subject_key text NOT NULL CHECK (length(subject_key) BETWEEN 1 AND 120),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  status text NOT NULL CHECK (status IN ('accepted','unknown','failed','suppressed')),
  scheduled_at timestamptz,
  accepted_at timestamptz,
  error_category text CHECK (length(error_category) <= 120),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(user_id,job_id) REFERENCES notification_jobs(user_id,id),
  UNIQUE(job_id,attempt_number),
  UNIQUE(user_id,idempotency_key)
);
CREATE INDEX notification_logs_user_created_idx ON notification_logs(user_id,created_at DESC);
CREATE TABLE scheduler_cursors (
  partition_key text PRIMARY KEY CHECK (length(partition_key) BETWEEN 1 AND 120),
  evaluated_through timestamptz NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 160),
  target_type text NOT NULL CHECK (length(target_type) BETWEEN 1 AND 120),
  target_id uuid,
  redacted_context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(redacted_context) = 'object' AND octet_length(redacted_context::text) <= 4096),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor_time_idx ON audit_logs(actor_user_id,occurred_at DESC);
