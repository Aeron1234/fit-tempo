CREATE TABLE nutrition_target_revisions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  effective_from date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  energy_kcal integer NOT NULL CHECK (energy_kcal > 0),
  protein_g integer NOT NULL CHECK (protein_g >= 0),
  carbs_g integer NOT NULL CHECK (carbs_g >= 0),
  fat_g integer NOT NULL CHECK (fat_g >= 0),
  client_operation_id uuid NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (user_id, revision),
  UNIQUE (user_id, client_operation_id)
);
