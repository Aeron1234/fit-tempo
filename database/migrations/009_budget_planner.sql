ALTER TABLE meal_plans ADD COLUMN deducted_at timestamptz;
ALTER TABLE shopping_items ALTER COLUMN shortage_quantity DROP NOT NULL;
ALTER TABLE shopping_items ADD COLUMN food_name text NOT NULL DEFAULT '';
ALTER TABLE mutation_results DROP CONSTRAINT mutation_results_operation_type_check;
ALTER TABLE mutation_results ADD CHECK (operation_type IN
 ('accept_schedule','deduct_pantry','complete_day','reopen_day','complete_workout','log_meal','edit_meal','delete_meal','edit_meal_item','create_pantry_lot','edit_pantry_lot','delete_pantry_lot','confirm_meal_plan'));
ALTER TABLE operation_receipts DROP CONSTRAINT operation_receipts_operation_type_check;
ALTER TABLE operation_receipts ADD CHECK (operation_type IN
 ('accept_schedule','deduct_pantry','complete_day','reopen_day','complete_workout','log_meal','edit_meal','delete_meal','edit_meal_item','create_pantry_lot','edit_pantry_lot','delete_pantry_lot','confirm_meal_plan'));
