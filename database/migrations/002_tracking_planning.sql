-- Snapshot JSONB is versioned and retained independently of mutable catalog rows.
CREATE TABLE fitness_goals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('energy','protein','carbs','fat','hydration','weight','activity','workouts')),
  target_value numeric(15,6) NOT NULL CHECK (target_value > 0),
  target_unit text NOT NULL CHECK (length(target_unit) BETWEEN 1 AND 24),
  baseline numeric(15,6) CHECK (baseline >= 0),
  effective_from date NOT NULL,
  effective_until date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_until IS NULL OR effective_until >= effective_from),
  UNIQUE(user_id,id)
);
CREATE INDEX fitness_goals_user_status_idx ON fitness_goals(user_id,status,effective_from);
CREATE TABLE meals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meal_type text NOT NULL CHECK (meal_type IN ('breakfast','lunch','dinner','snack')),
  occurred_at timestamptz NOT NULL,
  recorded_time_zone text NOT NULL CHECK (length(recorded_time_zone) BETWEEN 1 AND 128),
  recorded_local_date date NOT NULL,
  image_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id,image_id) REFERENCES files(user_id,id),
  UNIQUE (user_id,id)
);
CREATE INDEX meals_user_occurred_idx ON meals(user_id,occurred_at DESC,id);
CREATE INDEX meals_user_local_date_idx ON meals(user_id,recorded_local_date);
CREATE TABLE meal_items (
  id uuid PRIMARY KEY,
  meal_id uuid NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  food_id uuid REFERENCES foods(id),
  quantity numeric(15,6) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL CHECK (unit IN ('g','kg','mg','ml','l','count','serving','cup','tbsp','tsp')),
  grams numeric(15,6) CHECK (grams > 0),
  snapshot_schema_version smallint NOT NULL DEFAULT 1 CHECK (snapshot_schema_version = 1),
  nutrition_snapshot jsonb NOT NULL CHECK (jsonb_typeof(nutrition_snapshot) = 'object' AND octet_length(nutrition_snapshot::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meal_items_meal_idx ON meal_items(meal_id);

CREATE TABLE recipes (
  id uuid PRIMARY KEY,
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  visibility text NOT NULL CHECK (visibility IN ('private','draft','approved','retired')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
  servings numeric(15,6) NOT NULL CHECK (servings > 0),
  cooked_yield_grams numeric(15,6) CHECK (cooked_yield_grams > 0),
  prep_minutes integer CHECK (prep_minutes BETWEEN 0 AND 1440),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740990),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_id IS NULL AND visibility IN ('draft','approved','retired')) OR (owner_id IS NOT NULL AND visibility = 'private'))
);
CREATE INDEX recipes_owner_visibility_idx ON recipes(owner_id,visibility);
CREATE INDEX recipes_shared_approved_idx ON recipes(id) WHERE owner_id IS NULL AND visibility = 'approved';
-- A recipe meal item can retain the complete recipe version, yield and ingredient snapshot.
ALTER TABLE meal_items ADD COLUMN recipe_id uuid REFERENCES recipes(id);
ALTER TABLE meal_items ADD COLUMN recipe_snapshot_version smallint CHECK (recipe_snapshot_version = 1);
ALTER TABLE meal_items ADD COLUMN recipe_snapshot jsonb
  CHECK (recipe_snapshot IS NULL OR (jsonb_typeof(recipe_snapshot) = 'object' AND octet_length(recipe_snapshot::text) <= 131072));
ALTER TABLE meal_items ADD CONSTRAINT meal_items_recipe_snapshot_pair
  CHECK ((recipe_id IS NULL) = (recipe_snapshot IS NULL)
    AND (recipe_snapshot IS NULL) = (recipe_snapshot_version IS NULL));
CREATE TABLE recipe_items (
  id uuid PRIMARY KEY,
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  food_id uuid NOT NULL REFERENCES foods(id),
  quantity numeric(15,6) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL CHECK (unit IN ('g','kg','mg','ml','l','count','serving','cup','tbsp','tsp')),
  grams_per_unit numeric(15,6) CHECK (grams_per_unit > 0),
  conversion_food_revision bigint CHECK (conversion_food_revision BETWEEN 0 AND 9007199254740990),
  UNIQUE(recipe_id,id),
  CHECK ((grams_per_unit IS NULL) = (conversion_food_revision IS NULL))
);
CREATE INDEX recipe_items_food_idx ON recipe_items(food_id);
CREATE TABLE recipe_steps (
  id uuid PRIMARY KEY,
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  step_order integer NOT NULL CHECK (step_order BETWEEN 1 AND 100),
  instruction text NOT NULL CHECK (length(instruction) BETWEEN 1 AND 2000),
  UNIQUE(recipe_id,step_order)
);

CREATE TABLE pantry_items (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  food_id uuid NOT NULL REFERENCES foods(id),
  quantity numeric(15,6) NOT NULL CHECK (quantity >= 0),
  unit text NOT NULL CHECK (unit IN ('g','kg','mg','ml','l','count','serving','cup','tbsp','tsp')),
  expires_on date,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740990),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,id)
);
CREATE INDEX pantry_items_user_expiry_idx ON pantry_items(user_id,expires_on,id);
CREATE INDEX pantry_items_food_idx ON pantry_items(food_id);
CREATE TABLE ingredient_prices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  food_id uuid NOT NULL REFERENCES foods(id),
  amount numeric(15,6) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  unit_quantity numeric(15,6) NOT NULL CHECK (unit_quantity > 0),
  unit text NOT NULL CHECK (unit IN ('g','kg','mg','ml','l','count','serving','cup','tbsp','tsp')),
  price_basis text NOT NULL CHECK (price_basis IN ('unit','package')),
  store_name text CHECK (length(store_name) <= 120),
  recorded_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingredient_prices_user_food_idx ON ingredient_prices(user_id,food_id,recorded_at DESC);
CREATE TABLE meal_plans (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipe_id uuid REFERENCES recipes(id),
  recipe_snapshot_version smallint NOT NULL DEFAULT 1 CHECK (recipe_snapshot_version = 1),
  recipe_snapshot jsonb NOT NULL CHECK (jsonb_typeof(recipe_snapshot) = 'object' AND octet_length(recipe_snapshot::text) <= 131072),
  servings numeric(15,6) NOT NULL CHECK (servings > 0),
  planned_at timestamptz NOT NULL,
  budget numeric(15,6) CHECK (budget >= 0),
  currency char(3) CHECK (currency ~ '^[A-Z]{3}$'),
  state text NOT NULL CHECK (state IN ('proposal','confirmed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((budget IS NULL) = (currency IS NULL)),
  UNIQUE(user_id,id)
);
CREATE INDEX meal_plans_user_state_idx ON meal_plans(user_id,state,planned_at);
CREATE TABLE shopping_items (
  id uuid PRIMARY KEY,
  meal_plan_id uuid NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
  food_id uuid REFERENCES foods(id),
  shortage_quantity numeric(15,6) NOT NULL CHECK (shortage_quantity >= 0),
  unit text NOT NULL CHECK (unit IN ('g','kg','mg','ml','l','count','serving','cup','tbsp','tsp')),
  package_quantity numeric(15,6) CHECK (package_quantity > 0),
  price_snapshot numeric(15,6) CHECK (price_snapshot >= 0),
  currency char(3) CHECK (currency ~ '^[A-Z]{3}$'),
  purchased boolean NOT NULL DEFAULT false,
  CHECK ((price_snapshot IS NULL) = (currency IS NULL))
);
CREATE INDEX shopping_items_plan_idx ON shopping_items(meal_plan_id);

CREATE TABLE availability_slots (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  local_start time NOT NULL,
  local_end time NOT NULL,
  time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 128),
  equipment jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(equipment) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (local_end > local_start)
);
CREATE INDEX availability_slots_user_day_idx ON availability_slots(user_id,weekday,local_start);
CREATE TABLE scheduled_workouts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  routine_id uuid NOT NULL REFERENCES workout_routines(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  recorded_time_zone text NOT NULL CHECK (length(recorded_time_zone) BETWEEN 1 AND 128),
  recorded_local_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('planned','missed','cancelled','completed','skipped')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740990),
  variant_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE(user_id,id)
);
CREATE INDEX scheduled_workouts_user_status_time_idx ON scheduled_workouts(user_id,status,starts_at);
CREATE UNIQUE INDEX scheduled_workouts_active_slot_idx ON scheduled_workouts(user_id,starts_at) WHERE status IN ('planned','missed');
CREATE TABLE schedule_proposals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base_revision bigint NOT NULL CHECK (base_revision BETWEEN 0 AND 9007199254740990),
  proposed_changes jsonb NOT NULL CHECK (jsonb_typeof(proposed_changes) = 'object' AND octet_length(proposed_changes::text) <= 65536),
  expires_at timestamptz NOT NULL,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,id),
  CHECK (expires_at > created_at)
);
CREATE INDEX schedule_proposals_user_expiry_idx ON schedule_proposals(user_id,expires_at);
CREATE TABLE workout_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_workout_id uuid,
  routine_snapshot_version smallint NOT NULL DEFAULT 1 CHECK (routine_snapshot_version = 1),
  routine_snapshot jsonb NOT NULL CHECK (jsonb_typeof(routine_snapshot) = 'object' AND octet_length(routine_snapshot::text) <= 131072),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  recorded_time_zone text NOT NULL CHECK (length(recorded_time_zone) BETWEEN 1 AND 128),
  recorded_local_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('active','paused','completed','cancelled')),
  actual_duration_seconds integer CHECK (actual_duration_seconds >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(user_id,scheduled_workout_id) REFERENCES scheduled_workouts(user_id,id),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  UNIQUE(user_id,id)
);
CREATE INDEX workout_sessions_user_started_idx ON workout_sessions(user_id,started_at DESC);
CREATE UNIQUE INDEX workout_sessions_scheduled_once_idx ON workout_sessions(scheduled_workout_id) WHERE scheduled_workout_id IS NOT NULL AND status = 'completed';
CREATE TABLE workout_sets (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
  exercise_id uuid REFERENCES exercises(id),
  set_order integer NOT NULL CHECK (set_order BETWEEN 1 AND 100),
  measurement_type text NOT NULL CHECK (measurement_type IN ('externalLoad','bodyweight','timed','distance')),
  actual_reps integer CHECK (actual_reps BETWEEN 1 AND 10000),
  actual_load_kg numeric(15,6) CHECK (actual_load_kg >= 0),
  actual_seconds numeric(15,6) CHECK (actual_seconds > 0),
  actual_meters numeric(15,6) CHECK (actual_meters > 0),
  UNIQUE(session_id,exercise_id,set_order)
);
CREATE INDEX workout_sets_session_idx ON workout_sets(session_id);

CREATE TABLE activity_logs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('walking','running','cycling','other')),
  occurred_at timestamptz NOT NULL,
  recorded_time_zone text NOT NULL CHECK (length(recorded_time_zone) BETWEEN 1 AND 128),
  recorded_local_date date NOT NULL,
  duration_seconds integer CHECK (duration_seconds > 0),
  distance_meters numeric(15,6) CHECK (distance_meters > 0),
  source text NOT NULL CHECK (source IN ('manual','workout')),
  linked_workout_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(user_id,linked_workout_id) REFERENCES workout_sessions(user_id,id)
);
CREATE INDEX activity_logs_user_occurred_idx ON activity_logs(user_id,occurred_at DESC,id);
CREATE TABLE daily_steps (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recorded_local_date date NOT NULL,
  steps integer NOT NULL CHECK (steps >= 0),
  source text NOT NULL CHECK (source IN ('manual','imported')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,recorded_local_date,source)
);
CREATE TABLE water_logs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_ml numeric(15,6) NOT NULL CHECK (amount_ml > 0),
  occurred_at timestamptz NOT NULL,
  recorded_time_zone text NOT NULL CHECK (length(recorded_time_zone) BETWEEN 1 AND 128),
  recorded_local_date date NOT NULL,
  client_operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,client_operation_id)
);
CREATE INDEX water_logs_user_occurred_idx ON water_logs(user_id,occurred_at DESC,id);
CREATE TABLE weight_logs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weight_kg numeric(15,6) NOT NULL CHECK (weight_kg > 0),
  measured_at timestamptz NOT NULL,
  recorded_time_zone text NOT NULL CHECK (length(recorded_time_zone) BETWEEN 1 AND 128),
  recorded_local_date date NOT NULL,
  note text CHECK (length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX weight_logs_user_measured_idx ON weight_logs(user_id,measured_at DESC,id);
CREATE TABLE measurement_logs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  measurement_type text NOT NULL CHECK (length(measurement_type) BETWEEN 1 AND 80),
  value_cm numeric(15,6) NOT NULL CHECK (value_cm > 0),
  measured_at timestamptz NOT NULL,
  recorded_time_zone text NOT NULL CHECK (length(recorded_time_zone) BETWEEN 1 AND 128),
  recorded_local_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX measurement_logs_user_measured_idx ON measurement_logs(user_id,measured_at DESC,id);
CREATE TABLE progress_photos (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id uuid NOT NULL,
  taken_at timestamptz NOT NULL,
  caption text CHECK (length(caption) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(user_id,file_id) REFERENCES files(user_id,id)
);
CREATE INDEX progress_photos_user_taken_idx ON progress_photos(user_id,taken_at DESC);
CREATE TABLE milestone_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_id uuid,
  milestone_key text NOT NULL CHECK (length(milestone_key) BETWEEN 1 AND 160),
  milestone_version integer NOT NULL CHECK (milestone_version > 0),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(user_id,goal_id) REFERENCES fitness_goals(user_id,id),
  UNIQUE(user_id,milestone_key,milestone_version)
);
CREATE TABLE ai_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('food_photo','plan_explanation','schedule_explanation')),
  status text NOT NULL CHECK (status IN ('reserved','completed','failed','expired')),
  usage_units integer CHECK (usage_units >= 0),
  request_id uuid NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_requests_user_type_time_idx ON ai_requests(user_id,type,created_at DESC);
