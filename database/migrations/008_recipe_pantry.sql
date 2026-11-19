ALTER TABLE recipes ADD COLUMN archived_at timestamptz;
ALTER TABLE recipe_items ADD COLUMN position integer NOT NULL DEFAULT 0 CHECK (position >= 0);
CREATE INDEX recipe_items_recipe_position_idx ON recipe_items(recipe_id, position, id);
ALTER TABLE ingredient_prices ALTER COLUMN amount DROP NOT NULL;

ALTER TABLE mutation_results DROP CONSTRAINT mutation_results_operation_type_check;
ALTER TABLE mutation_results ADD CHECK (operation_type IN
  ('accept_schedule','deduct_pantry','complete_day','reopen_day','complete_workout','log_meal','edit_meal','delete_meal','edit_meal_item','create_pantry_lot','edit_pantry_lot','delete_pantry_lot'));
ALTER TABLE operation_receipts DROP CONSTRAINT operation_receipts_operation_type_check;
ALTER TABLE operation_receipts ADD CHECK (operation_type IN
  ('accept_schedule','deduct_pantry','complete_day','reopen_day','complete_workout','log_meal','edit_meal','delete_meal','edit_meal_item','create_pantry_lot','edit_pantry_lot','delete_pantry_lot'));

-- Archived recipes remain referenced by historical rows but cannot acquire new links.
CREATE OR REPLACE FUNCTION fit_assert_visible_recipe(resource_id uuid, actor_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM recipes WHERE id = resource_id AND archived_at IS NULL
    AND ((owner_id = actor_id AND visibility = 'private')
      OR (owner_id IS NULL AND visibility = 'approved')) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Related recipe unavailable'; END IF;
END $$;
