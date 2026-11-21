CREATE UNIQUE INDEX activity_logs_workout_once_idx
  ON activity_logs(user_id, linked_workout_id) WHERE linked_workout_id IS NOT NULL;

ALTER TABLE activity_logs ADD CONSTRAINT activity_logs_link_source_check
  CHECK ((source = 'workout') = (linked_workout_id IS NOT NULL));

CREATE INDEX activity_logs_user_local_date_idx ON activity_logs(user_id, recorded_local_date DESC, occurred_at DESC, id);
CREATE INDEX weight_logs_user_local_date_idx ON weight_logs(user_id, recorded_local_date DESC, measured_at DESC, id);
CREATE INDEX measurement_logs_user_local_date_idx ON measurement_logs(user_id, recorded_local_date DESC, measured_at DESC, id);
