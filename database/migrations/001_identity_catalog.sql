-- Fit Tempo Phase 05. Applied in filename order by the migration runner in one transaction.
-- IDs are UUIDs supplied by the application. Privileged migrations, restricted runtime role.
CREATE TABLE roles (
  code text PRIMARY KEY CHECK (code IN ('trainee', 'admin')),
  description text NOT NULL
);
INSERT INTO roles (code, description) VALUES ('trainee', 'Personal tracking account'), ('admin', 'Shared catalog administration');

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND length(email) <= 320),
  password_hash text NOT NULL,
  role_code text NOT NULL DEFAULT 'trainee' REFERENCES roles(code),
  verified_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (idle_expires_at <= absolute_expires_at)
);
CREATE INDEX sessions_user_active_idx ON sessions(user_id, idle_expires_at) WHERE revoked_at IS NULL;
CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  consumed_at timestamptz,
  replacement_id uuid REFERENCES refresh_tokens(id) DEFERRABLE INITIALLY DEFERRED,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens(session_id, family_id);
CREATE TABLE verification_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_tokens_user_idx ON verification_tokens(user_id, purpose, expires_at);

CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  height_cm numeric(15,6) CHECK (height_cm > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  time_zone text NOT NULL DEFAULT 'Asia/Manila' CHECK (length(time_zone) BETWEEN 1 AND 128),
  mass_unit text NOT NULL DEFAULT 'kg' CHECK (mass_unit IN ('kg','lb')),
  theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  recommendation_version bigint NOT NULL DEFAULT 0 CHECK (recommendation_version BETWEEN 0 AND 9007199254740990),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE files (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 1 AND 512),
  kind text NOT NULL CHECK (kind IN ('food_photo','profile_image','progress_photo')),
  mime_type text CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  byte_size bigint CHECK (byte_size BETWEEN 0 AND 10485760),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);
CREATE INDEX files_owner_state_idx ON files(user_id, state);
ALTER TABLE profiles ADD COLUMN profile_image_id uuid;
ALTER TABLE profiles ADD CONSTRAINT profiles_owned_image_fk FOREIGN KEY (user_id, profile_image_id) REFERENCES files(user_id,id);

CREATE TABLE food_categories (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE foods (
  id uuid PRIMARY KEY,
  category_id uuid REFERENCES food_categories(id),
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  visibility text NOT NULL CHECK (visibility IN ('private','draft','approved','retired')),
  source_kind text NOT NULL CHECK (source_kind IN ('curated','user','usda','open_food_facts')),
  source_record_id text NOT NULL CHECK (length(source_record_id) BETWEEN 1 AND 128),
  source_revision bigint NOT NULL DEFAULT 0 CHECK (source_revision BETWEEN 0 AND 9007199254740990),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
  preparation text NOT NULL DEFAULT 'unspecified' CHECK (preparation IN ('raw','cooked','unspecified')),
  basis text NOT NULL CHECK (basis IN ('per100g','perServing')),
  basis_grams numeric(15,6) CHECK (basis_grams > 0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740990),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_id IS NULL AND visibility IN ('draft','approved','retired')) OR (owner_id IS NOT NULL AND visibility = 'private')),
  CHECK (basis <> 'per100g' OR basis_grams = 100),
  UNIQUE (source_kind, source_record_id),
  CHECK ((source_kind IN ('curated','user') AND source_record_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      OR (source_kind IN ('usda','open_food_facts') AND source_record_id ~ '^[0-9]{1,32}$'))
);
CREATE INDEX foods_owner_visibility_idx ON foods(owner_id, visibility, name);
CREATE INDEX foods_shared_approved_idx ON foods(name, id) WHERE owner_id IS NULL AND visibility = 'approved';
CREATE TABLE food_nutrients (
  food_id uuid NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  nutrient_code text NOT NULL CHECK (nutrient_code IN ('energyKcal','proteinG','carbsG','fatG','fiberG','sodiumMg')),
  amount numeric(15,6) CHECK (amount >= 0),
  unit text NOT NULL CHECK (unit IN ('kcal','g','mg')),
  PRIMARY KEY (food_id,nutrient_code),
  CHECK ((nutrient_code = 'energyKcal' AND unit = 'kcal') OR (nutrient_code = 'sodiumMg' AND unit = 'mg') OR (nutrient_code IN ('proteinG','carbsG','fatG','fiberG') AND unit = 'g'))
);
CREATE TABLE exercise_categories (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 120),
  muscle_groups jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(muscle_groups) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE exercises (
  id uuid PRIMARY KEY,
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  visibility text NOT NULL CHECK (visibility IN ('private','draft','approved','retired')),
  category_id uuid REFERENCES exercise_categories(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
  equipment text,
  instructions text CHECK (length(instructions) <= 4000),
  measurement_type text NOT NULL CHECK (measurement_type IN ('externalLoad','bodyweight','timed','distance')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740990),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_id IS NULL AND visibility IN ('draft','approved','retired')) OR (owner_id IS NOT NULL AND visibility = 'private'))
);
CREATE INDEX exercises_owner_visibility_idx ON exercises(owner_id, visibility, name);
CREATE INDEX exercises_shared_approved_idx ON exercises(name, id) WHERE owner_id IS NULL AND visibility = 'approved';

CREATE TABLE workout_routines (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  visibility text NOT NULL CHECK (visibility IN ('private','draft','approved','retired')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 240),
  duration_minutes integer CHECK (duration_minutes BETWEEN 1 AND 1440),
  level text CHECK (level IN ('beginner','intermediate','advanced')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740990),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NULL AND visibility IN ('draft','approved','retired')) OR (user_id IS NOT NULL AND visibility = 'private'))
);
CREATE INDEX workout_routines_owner_visibility_idx ON workout_routines(user_id, visibility);
CREATE INDEX workout_routines_shared_approved_idx ON workout_routines(id) WHERE user_id IS NULL AND visibility = 'approved';
CREATE TABLE routine_exercises (
  id uuid PRIMARY KEY,
  routine_id uuid NOT NULL REFERENCES workout_routines(id) ON DELETE CASCADE,
  exercise_id uuid NOT NULL REFERENCES exercises(id),
  exercise_order integer NOT NULL CHECK (exercise_order BETWEEN 1 AND 100),
  target_sets integer CHECK (target_sets BETWEEN 1 AND 100),
  target_reps integer CHECK (target_reps BETWEEN 1 AND 10000),
  target_load_kg numeric(15,6) CHECK (target_load_kg >= 0),
  target_seconds numeric(15,6) CHECK (target_seconds > 0),
  target_meters numeric(15,6) CHECK (target_meters > 0),
  rest_seconds integer CHECK (rest_seconds BETWEEN 0 AND 86400),
  UNIQUE (routine_id, exercise_order)
);
CREATE INDEX routine_exercises_exercise_idx ON routine_exercises(exercise_id);
