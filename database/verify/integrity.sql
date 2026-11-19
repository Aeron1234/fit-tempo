-- Run with psql -v ON_ERROR_STOP=1 -f against an isolated Phase 05 database.
-- All synthetic rows are rolled back. Errors are caught only where expected.
BEGIN;
INSERT INTO users(id,email,password_hash) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','phase05-a@example.invalid','test-only'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','phase05-b@example.invalid','test-only');
INSERT INTO schedule_revisions(user_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
INSERT INTO pantry_revisions(user_id) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
INSERT INTO foods(id,owner_id,visibility,source_kind,source_record_id,name,basis,basis_grams)
VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'private','user','cccccccc-cccc-4ccc-8ccc-cccccccccccc','Private food','per100g',100);
INSERT INTO meals(id,user_id,meal_type,occurred_at,recorded_time_zone,recorded_local_date)
VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'lunch','2026-11-16T04:00:00Z','Asia/Manila','2026-11-16');
DO $$ BEGIN
  BEGIN
    INSERT INTO meal_items(id,meal_id,food_id,quantity,unit,nutrition_snapshot)
    VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc',1,'count','{}');
    RAISE EXCEPTION 'cross-owner food was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM meal_items WHERE id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') THEN
    RAISE EXCEPTION 'failed relationship insert left an item';
  END IF;
END $$;
INSERT INTO foods(id,visibility,source_kind,source_record_id,name,basis,basis_grams)
VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff','approved','curated',
        'ffffffff-ffff-4fff-8fff-ffffffffffff','Shared food','per100g',100);
INSERT INTO meal_items(id,meal_id,food_id,quantity,unit,nutrition_snapshot)
VALUES ('11111111-1111-4111-8111-111111111111','dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        'ffffffff-ffff-4fff-8fff-ffffffffffff',1,'count','{"schemaVersion":1}');
DO $$ BEGIN
  BEGIN
    UPDATE meal_items SET nutrition_snapshot='{}' WHERE id='11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'historical snapshot was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT nutrition_snapshot FROM meal_items WHERE id='11111111-1111-4111-8111-111111111111') <> '{"schemaVersion":1}'::jsonb THEN
    RAISE EXCEPTION 'failed snapshot update changed history';
  END IF;
END $$;
INSERT INTO pantry_items(id,user_id,food_id,quantity,unit)
VALUES ('22222222-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',1,'count');
DO $$ BEGIN
  BEGIN
    UPDATE pantry_items SET quantity=-1 WHERE id='22222222-2222-4222-8222-222222222222';
    RAISE EXCEPTION 'negative pantry balance was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
INSERT INTO daily_tracking_status(id,user_id,category,recorded_local_date,recorded_time_zone,state,entry_count,confirmed_at)
VALUES ('33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'nutrition','2026-11-16','Asia/Manila','complete',0,now());
DO $$ BEGIN
  IF (SELECT state FROM daily_tracking_status WHERE id='33333333-3333-4333-8333-333333333333') <> 'complete' THEN
    RAISE EXCEPTION 'confirmed zero day is not complete';
  END IF;
  IF EXISTS (SELECT 1 FROM daily_tracking_status WHERE user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
             AND category='nutrition' AND recorded_local_date='2026-11-17') THEN
    RAISE EXCEPTION 'missing day became a recorded zero';
  END IF;
END $$;
INSERT INTO mutation_results(id,user_id,operation_type,commit_summary)
VALUES ('44444444-4444-4444-8444-444444444444','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','deduct_pantry','{}');
INSERT INTO operation_receipts(id,user_id,operation_type,client_operation_id,payload_digest,result_reference)
VALUES ('55555555-5555-4555-8555-555555555555','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'deduct_pantry','66666666-6666-4666-8666-666666666666',repeat('a',64),
        '44444444-4444-4444-8444-444444444444');
DO $$ BEGIN
  BEGIN
    INSERT INTO operation_receipts(id,user_id,operation_type,client_operation_id,payload_digest,result_reference)
    VALUES ('77777777-7777-4777-8777-777777777777','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'deduct_pantry','66666666-6666-4666-8666-666666666666',repeat('b',64),
            '44444444-4444-4444-8444-444444444444');
    RAISE EXCEPTION 'duplicate operation key was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
SELECT 'integrity checks passed (rolling back fixtures)' AS outcome;
ROLLBACK;

-- A failed/cancelled write must persist neither its result nor receipt.
BEGIN;
INSERT INTO users(id,email,password_hash)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','phase05-a@example.invalid','test-only');
INSERT INTO mutation_results(id,user_id,operation_type,commit_summary)
VALUES ('88888888-8888-4888-8888-888888888888','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','deduct_pantry','{}');
INSERT INTO operation_receipts(id,user_id,operation_type,client_operation_id,payload_digest,result_reference)
VALUES ('99999999-9999-4999-8999-999999999999','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'deduct_pantry','10101010-1010-4010-8010-101010101010',repeat('c',64),
        '88888888-8888-4888-8888-888888888888');
ROLLBACK;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM mutation_results WHERE id='88888888-8888-4888-8888-888888888888')
    OR EXISTS (SELECT 1 FROM operation_receipts WHERE id='99999999-9999-4999-8999-999999999999') THEN
    RAISE EXCEPTION 'rolled-back mutation or receipt persisted';
  END IF;
END $$;
SELECT 'rollback left no mutation result or receipt' AS outcome;
