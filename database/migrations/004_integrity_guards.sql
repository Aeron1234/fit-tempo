-- Defense in depth for relationships. API authorization still derives identity from sessions.
-- Catalog edits need to use compatible row locks; historical references remain after retirement.
CREATE FUNCTION fit_assert_visible_food(resource_id uuid, actor_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM foods WHERE id = resource_id
    AND ((owner_id = actor_id AND visibility = 'private')
      OR (owner_id IS NULL AND visibility = 'approved')) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Related food unavailable'; END IF;
END $$;
CREATE FUNCTION fit_assert_visible_recipe(resource_id uuid, actor_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM recipes WHERE id = resource_id
    AND ((owner_id = actor_id AND visibility = 'private')
      OR (owner_id IS NULL AND visibility = 'approved')) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Related recipe unavailable'; END IF;
END $$;
CREATE FUNCTION fit_assert_visible_exercise(resource_id uuid, actor_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM exercises WHERE id = resource_id
    AND ((owner_id = actor_id AND visibility = 'private')
      OR (owner_id IS NULL AND visibility = 'approved')) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Related exercise unavailable'; END IF;
END $$;
CREATE FUNCTION fit_assert_visible_routine(resource_id uuid, actor_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM workout_routines WHERE id = resource_id
    AND ((user_id = actor_id AND visibility = 'private')
      OR (user_id IS NULL AND visibility = 'approved')) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Related routine unavailable'; END IF;
END $$;
CREATE FUNCTION fit_assert_ready_file(resource_id uuid, actor_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM files WHERE id = resource_id AND user_id = actor_id AND state = 'ready' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Related file unavailable'; END IF;
END $$;

CREATE FUNCTION fit_guard_relationships() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_id uuid;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'profiles' THEN
      IF NEW.profile_image_id IS NOT NULL THEN PERFORM fit_assert_ready_file(NEW.profile_image_id, NEW.user_id); END IF;
    WHEN 'meals' THEN
      IF NEW.image_id IS NOT NULL THEN PERFORM fit_assert_ready_file(NEW.image_id, NEW.user_id); END IF;
    WHEN 'progress_photos' THEN
      PERFORM fit_assert_ready_file(NEW.file_id, NEW.user_id);
    WHEN 'meal_items' THEN
      SELECT user_id INTO actor_id FROM meals WHERE id = NEW.meal_id FOR SHARE;
      IF actor_id IS NULL THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Parent meal unavailable'; END IF;
      IF NEW.food_id IS NOT NULL THEN PERFORM fit_assert_visible_food(NEW.food_id, actor_id); END IF;
      IF NEW.recipe_id IS NOT NULL THEN PERFORM fit_assert_visible_recipe(NEW.recipe_id, actor_id); END IF;
    WHEN 'recipe_items' THEN
      SELECT owner_id INTO actor_id FROM recipes WHERE id = NEW.recipe_id FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Parent recipe unavailable'; END IF;
      PERFORM fit_assert_visible_food(NEW.food_id, actor_id);
    WHEN 'pantry_items' THEN
      PERFORM fit_assert_visible_food(NEW.food_id, NEW.user_id);
    WHEN 'ingredient_prices' THEN
      PERFORM fit_assert_visible_food(NEW.food_id, NEW.user_id);
    WHEN 'meal_plans' THEN
      IF NEW.recipe_id IS NOT NULL THEN PERFORM fit_assert_visible_recipe(NEW.recipe_id, NEW.user_id); END IF;
    WHEN 'shopping_items' THEN
      SELECT user_id INTO actor_id FROM meal_plans WHERE id = NEW.meal_plan_id FOR SHARE;
      IF actor_id IS NULL THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Parent meal plan unavailable'; END IF;
      IF NEW.food_id IS NOT NULL THEN PERFORM fit_assert_visible_food(NEW.food_id, actor_id); END IF;
    WHEN 'routine_exercises' THEN
      SELECT user_id INTO actor_id FROM workout_routines WHERE id = NEW.routine_id FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Parent routine unavailable'; END IF;
      PERFORM fit_assert_visible_exercise(NEW.exercise_id, actor_id);
    WHEN 'scheduled_workouts' THEN
      PERFORM fit_assert_visible_routine(NEW.routine_id, NEW.user_id);
    WHEN 'workout_sets' THEN
      SELECT user_id INTO actor_id FROM workout_sessions WHERE id = NEW.session_id FOR SHARE;
      IF actor_id IS NULL THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Parent session unavailable'; END IF;
      IF NEW.exercise_id IS NOT NULL THEN PERFORM fit_assert_visible_exercise(NEW.exercise_id, actor_id); END IF;
  END CASE;
  RETURN NEW;
END $$;
CREATE TRIGGER profiles_resource_guard BEFORE INSERT OR UPDATE OF profile_image_id,user_id ON profiles FOR EACH ROW EXECUTE FUNCTION fit_guard_relationships();
CREATE TRIGGER meals_resource_guard BEFORE INSERT OR UPDATE OF image_id,user_id ON meals FOR EACH ROW EXECUTE FUNCTION fit_guard_relationships();
CREATE TRIGGER progress_photos_resource_guard BEFORE INSERT OR UPDATE OF file_id,user_id ON progress_photos FOR EACH ROW EXECUTE FUNCTION fit_guard_relationships();
CREATE TRIGGER meal_items_resource_guard BEFORE INSERT OR UPDATE OF food_id,recipe_id,meal_id ON meal_items FOR EACH ROW EXECUTE FUNCTION fit_guard_relationships();
CREATE TRIGGER recipe_items_resource_guard BEFORE INSERT OR UPDATE OF food_id,recipe_id ON recipe_items FOR EACH ROW EXECUTE FUNCTION fit_guard_relationships();
CREATE TRIGGER pantry_items_resource_guard BEFORE INSERT OR UPDATE OF food_id,user_id ON pantry_items FOR EACH ROW EXECUTE FUNCTION fit_guard_relationships();
CREATE TRIGGER ingredient_prices_resource_guard BEFORE INSERT OR UPDATE OF food_id,user_id ON ingredient_prices FOR EACH ROW EXECUTE FUNCTION fit_guard_relationships();
CREATE TRIGGER meal_plans_resource_guard BEFORE INSERT OR UPDATE OF recipe_id,user_id ON meal_plans FOR EACH ROW EXECUTE FUNCTION fit_guard_relationships();
CREATE TRIGGER shopping_items_resource_guard BEFORE INSERT OR UPDATE OF food_id,meal_plan_id ON shopping_items FOR EACH ROW EXECUTE FUNCTION fit_guard_relationships();
CREATE TRIGGER routine_exercises_resource_guard BEFORE INSERT OR UPDATE OF exercise_id,routine_id ON routine_exercises FOR EACH ROW EXECUTE FUNCTION fit_guard_relationships();
CREATE TRIGGER scheduled_workouts_resource_guard BEFORE INSERT OR UPDATE OF routine_id,user_id ON scheduled_workouts FOR EACH ROW EXECUTE FUNCTION fit_guard_relationships();
CREATE TRIGGER workout_sets_resource_guard BEFORE INSERT OR UPDATE OF exercise_id,session_id ON workout_sets FOR EACH ROW EXECUTE FUNCTION fit_guard_relationships();

-- Preserve the recorded local date at creation and during deliberate timestamp edits.
CREATE FUNCTION fit_guard_recorded_date() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_at timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.recorded_time_zone) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Unknown recorded time zone';
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'meals','activity_logs','water_logs' THEN event_at := NEW.occurred_at;
    WHEN 'scheduled_workouts' THEN event_at := NEW.starts_at;
    WHEN 'workout_sessions' THEN event_at := NEW.started_at;
    WHEN 'weight_logs','measurement_logs' THEN event_at := NEW.measured_at;
  END CASE;
  IF (event_at AT TIME ZONE NEW.recorded_time_zone)::date IS DISTINCT FROM NEW.recorded_local_date THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Recorded local date disagrees with instant and zone';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meals_date_guard BEFORE INSERT OR UPDATE ON meals FOR EACH ROW EXECUTE FUNCTION fit_guard_recorded_date();
CREATE TRIGGER scheduled_workouts_date_guard BEFORE INSERT OR UPDATE ON scheduled_workouts FOR EACH ROW EXECUTE FUNCTION fit_guard_recorded_date();
CREATE TRIGGER workout_sessions_date_guard BEFORE INSERT OR UPDATE ON workout_sessions FOR EACH ROW EXECUTE FUNCTION fit_guard_recorded_date();
CREATE TRIGGER activity_logs_date_guard BEFORE INSERT OR UPDATE ON activity_logs FOR EACH ROW EXECUTE FUNCTION fit_guard_recorded_date();
CREATE TRIGGER water_logs_date_guard BEFORE INSERT OR UPDATE ON water_logs FOR EACH ROW EXECUTE FUNCTION fit_guard_recorded_date();
CREATE TRIGGER weight_logs_date_guard BEFORE INSERT OR UPDATE ON weight_logs FOR EACH ROW EXECUTE FUNCTION fit_guard_recorded_date();
CREATE TRIGGER measurement_logs_date_guard BEFORE INSERT OR UPDATE ON measurement_logs FOR EACH ROW EXECUTE FUNCTION fit_guard_recorded_date();

CREATE FUNCTION fit_guard_immutable_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'meal_items' THEN
    IF OLD.nutrition_snapshot IS DISTINCT FROM NEW.nutrition_snapshot
        OR OLD.snapshot_schema_version IS DISTINCT FROM NEW.snapshot_schema_version
        OR OLD.quantity IS DISTINCT FROM NEW.quantity OR OLD.unit IS DISTINCT FROM NEW.unit
        OR OLD.grams IS DISTINCT FROM NEW.grams OR OLD.food_id IS DISTINCT FROM NEW.food_id
        OR OLD.recipe_id IS DISTINCT FROM NEW.recipe_id
        OR OLD.recipe_snapshot IS DISTINCT FROM NEW.recipe_snapshot
        OR OLD.recipe_snapshot_version IS DISTINCT FROM NEW.recipe_snapshot_version
        OR OLD.meal_id IS DISTINCT FROM NEW.meal_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Historical nutrition snapshot is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'meal_plans' THEN
    IF OLD.recipe_snapshot IS DISTINCT FROM NEW.recipe_snapshot
        OR OLD.recipe_snapshot_version IS DISTINCT FROM NEW.recipe_snapshot_version
        OR OLD.recipe_id IS DISTINCT FROM NEW.recipe_id OR OLD.servings IS DISTINCT FROM NEW.servings THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Historical recipe snapshot is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'workout_sessions' THEN
    IF OLD.routine_snapshot IS DISTINCT FROM NEW.routine_snapshot
        OR OLD.routine_snapshot_version IS DISTINCT FROM NEW.routine_snapshot_version
        OR (OLD.status = 'completed' AND (OLD.scheduled_workout_id IS DISTINCT FROM NEW.scheduled_workout_id
            OR OLD.started_at IS DISTINCT FROM NEW.started_at OR OLD.ended_at IS DISTINCT FROM NEW.ended_at)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Historical routine snapshot is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meal_items_snapshot_guard BEFORE UPDATE ON meal_items FOR EACH ROW EXECUTE FUNCTION fit_guard_immutable_snapshot();
CREATE TRIGGER meal_plans_snapshot_guard BEFORE UPDATE ON meal_plans FOR EACH ROW EXECUTE FUNCTION fit_guard_immutable_snapshot();
CREATE TRIGGER workout_sessions_snapshot_guard BEFORE UPDATE ON workout_sessions FOR EACH ROW EXECUTE FUNCTION fit_guard_immutable_snapshot();
