ALTER TABLE workout_sessions
  ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740990),
  ADD COLUMN elapsed_milliseconds bigint NOT NULL DEFAULT 0 CHECK (elapsed_milliseconds BETWEEN 0 AND 2147483647000),
  ADD COLUMN active_since timestamptz,
  ADD COLUMN rest_ends_at timestamptz,
  ADD COLUMN rest_remaining_milliseconds bigint NOT NULL DEFAULT 0 CHECK (rest_remaining_milliseconds BETWEEN 0 AND 86400000);

ALTER TABLE workout_sets
  ADD COLUMN exercise_index integer CHECK (exercise_index BETWEEN 0 AND 99),
  DROP CONSTRAINT workout_sets_session_id_exercise_id_set_order_key,
  ADD UNIQUE (session_id, exercise_index, set_order);

CREATE UNIQUE INDEX workout_sets_legacy_identity_idx
  ON workout_sets (session_id, exercise_id, set_order) WHERE exercise_index IS NULL;

-- Protect the template during tracking and persist the confirmed actuals exactly once.
DROP TRIGGER workout_sessions_snapshot_guard ON workout_sessions;
CREATE FUNCTION fit_guard_workout_session_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.status = 'completed' AND OLD IS DISTINCT FROM NEW)
    OR OLD.routine_snapshot_version IS DISTINCT FROM NEW.routine_snapshot_version
    OR (NEW.status <> 'completed' AND OLD.routine_snapshot IS DISTINCT FROM NEW.routine_snapshot)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Workout snapshot is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workout_sessions_snapshot_guard BEFORE UPDATE ON workout_sessions
FOR EACH ROW EXECUTE FUNCTION fit_guard_workout_session_update();
