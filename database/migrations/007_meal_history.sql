ALTER TABLE meals ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740990);
ALTER TABLE meals ADD COLUMN deleted_at timestamptz;
ALTER TABLE meal_items ADD COLUMN position integer NOT NULL DEFAULT 0 CHECK (position >= 0);

CREATE TABLE meal_history (
  user_id uuid NOT NULL,
  meal_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740990),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meal_id, revision),
  FOREIGN KEY (user_id, meal_id) REFERENCES meals(user_id, id) ON DELETE CASCADE
);

ALTER TABLE mutation_results DROP CONSTRAINT mutation_results_operation_type_check;
ALTER TABLE mutation_results ADD CHECK (operation_type IN
  ('accept_schedule','deduct_pantry','complete_day','reopen_day','complete_workout','log_meal','edit_meal','delete_meal','edit_meal_item'));
ALTER TABLE operation_receipts DROP CONSTRAINT operation_receipts_operation_type_check;
ALTER TABLE operation_receipts ADD CHECK (operation_type IN
  ('accept_schedule','deduct_pantry','complete_day','reopen_day','complete_workout','log_meal','edit_meal','delete_meal','edit_meal_item'));
