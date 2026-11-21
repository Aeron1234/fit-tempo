CREATE TABLE notification_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  global_opt_out boolean NOT NULL DEFAULT false,
  quiet_start time,
  quiet_end time,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740990),
  CHECK ((quiet_start IS NULL) = (quiet_end IS NULL)),
  CHECK (quiet_start IS NULL OR (quiet_start < '24:00'::time AND quiet_end < '24:00'::time AND quiet_start <> quiet_end))
);

ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_type_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_type_check
  CHECK (type IN ('workout_reminder', 'meal_reminder', 'hydration_reminder', 'weekly_summary', 'milestone', 'inactivity'));
ALTER TABLE notification_jobs DROP CONSTRAINT notification_jobs_type_check;
ALTER TABLE notification_jobs ADD CONSTRAINT notification_jobs_type_check
  CHECK (type IN ('workout_reminder', 'meal_reminder', 'hydration_reminder', 'weekly_summary', 'milestone', 'inactivity'));
