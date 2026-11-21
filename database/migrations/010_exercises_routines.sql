CREATE TABLE reviewed_routine_variants (
  routine_id uuid NOT NULL REFERENCES workout_routines(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES workout_routines(id) ON DELETE CASCADE,
  routine_revision bigint NOT NULL CHECK (routine_revision >= 0),
  variant_revision bigint NOT NULL CHECK (variant_revision >= 0),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (routine_id, variant_id),
  CHECK (routine_id <> variant_id)
);

INSERT INTO exercises (id,visibility,name,equipment,instructions,measurement_type) VALUES
 ('14000000-0000-4000-8000-000000000001','approved','Chair sit-to-stand','Stable chair','Stand up from the chair and lower back to the seat with control.','bodyweight'),
 ('14000000-0000-4000-8000-000000000002','approved','Standing march',NULL,'Alternate lifting each knee at a comfortable pace.','timed');

INSERT INTO workout_routines (id,visibility,name,duration_minutes,level) VALUES
 ('14000000-0000-4000-8000-000000000003','approved','Chair and march practice',15,'beginner'),
 ('14000000-0000-4000-8000-000000000004','approved','Short chair and march practice',8,'beginner');

INSERT INTO routine_exercises
 (id,routine_id,exercise_id,exercise_order,target_sets,target_reps,target_seconds,rest_seconds) VALUES
 ('14000000-0000-4000-8000-000000000005','14000000-0000-4000-8000-000000000003','14000000-0000-4000-8000-000000000001',1,3,8,NULL,60),
 ('14000000-0000-4000-8000-000000000006','14000000-0000-4000-8000-000000000003','14000000-0000-4000-8000-000000000002',2,3,NULL,45,60),
 ('14000000-0000-4000-8000-000000000007','14000000-0000-4000-8000-000000000004','14000000-0000-4000-8000-000000000001',1,2,5,NULL,60),
 ('14000000-0000-4000-8000-000000000008','14000000-0000-4000-8000-000000000004','14000000-0000-4000-8000-000000000002',2,2,NULL,30,60);

INSERT INTO reviewed_routine_variants (routine_id,variant_id,routine_revision,variant_revision) VALUES
 ('14000000-0000-4000-8000-000000000003','14000000-0000-4000-8000-000000000004',0,0);
ALTER TABLE workout_routines ADD COLUMN archived_at timestamptz;
