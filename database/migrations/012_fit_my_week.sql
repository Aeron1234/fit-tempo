CREATE TABLE schedule_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rest_days smallint[] NOT NULL DEFAULT '{}',
  CHECK (rest_days <@ ARRAY[0,1,2,3,4,5,6]::smallint[])
);
