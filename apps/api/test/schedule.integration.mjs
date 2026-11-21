import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import argon2 from 'argon2';
import { Pool } from 'pg';
import { scheduleResponseSchema, scheduleProposalResponseSchema } from '@fit-tempo/contracts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const target = databaseUrl && new URL(databaseUrl);
if (!target || !['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test')) {
  throw new Error('A disposable local TEST_DATABASE_URL ending in _test is required.');
}

test('Fit My Week previews a shorter Wednesday, rejects competing edits and replaces reminders atomically', async () => {
  const db = new Pool({ connectionString: databaseUrl });
  const owner = randomUUID(), peer = randomUUID();
  const password = 'Syntheticphase16Password!';
  const origin = 'http://localhost:5173';
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, NODE_ENV: 'development', APP_MODE: 'local', FOOD_ADAPTER: 'fixtures', FRONTEND_URL: origin,
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'),
  });
  delete process.env.REDIS_URL;
  const { app } = await import('../dist/app.js');
  const server = app.listen(0, '127.0.0.1');
  const email = id => `phase16-${id}@example.invalid`;
  try {
    await once(server, 'listening');
    function client() {
      const cookies = new Map();
      let csrf;
      async function request(path, method = 'GET', body, useCsrf = true) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, {
          method, signal: AbortSignal.timeout(8000),
          headers: {
            origin, cookie: [...cookies.values()].join('; '),
            ...(csrf && useCsrf ? { 'x-csrf-token': csrf } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        for (const value of response.headers.getSetCookie()) {
          const pair = value.split(';')[0];
          cookies.set(pair.split('=')[0], pair);
        }
        return { status: response.status, ...await response.json() };
      }
      async function login(id) {
        csrf = (await request('/auth/csrf')).data.csrfToken;
        assert.equal((await request('/auth/login', 'POST', { email: email(id), password })).status, 200);
        csrf = (await request('/auth/csrf')).data.csrfToken;
      }
      return { request, login };
    }

    const ownerClient = client(), peerClient = client();
    const { request } = ownerClient;
    assert.equal((await request('/me/scheduled-workouts')).status, 401);
    const hash = await argon2.hash(password);
    const baseRoutine = randomUUID();
    const variant = '14000000-0000-4000-8000-000000000004';
    const chair = '14000000-0000-4000-8000-000000000001';
    const missed = randomUUID(), secondMissed = randomUUID(), oldJob = randomUUID();
    try {
      await db.query('INSERT INTO users (id,email,password_hash,verified_at) VALUES ($1,$2,$3,now()),($4,$5,$3,now())',
        [owner, email(owner), hash, peer, email(peer)]);
      await Promise.all([ownerClient.login(owner), peerClient.login(peer)]);
      await db.query(`INSERT INTO workout_routines(id,visibility,name,duration_minutes,level)
        VALUES($1,'approved','Fixture full routine',30,'beginner')`, [baseRoutine]);
      await db.query(`INSERT INTO routine_exercises(id,routine_id,exercise_id,exercise_order,target_sets,target_reps)
        VALUES($1,$2,$3,1,3,8)`, [randomUUID(),baseRoutine,chair]);
      await db.query(`INSERT INTO reviewed_routine_variants(routine_id,variant_id,routine_revision,variant_revision)
        VALUES($1,$2,0,0)`, [baseRoutine,variant]);
      await db.query(`INSERT INTO notification_preferences(id,user_id,type,enabled,interval_minutes)
        VALUES($1,$2,'workout_reminder',true,30)`, [randomUUID(),owner]);
      const shifted = new Date(Date.now()+8*3_600_000);
      shifted.setUTCHours(12,0,0,0);
      const untilWednesday = (3-shifted.getUTCDay()+7)%7;
      shifted.setUTCDate(shifted.getUTCDate()+untilWednesday);
      const wednesday = shifted.toISOString().slice(0,10);
      let tuesday = new Date(shifted.getTime()-86400_000-8*3_600_000);
      if (tuesday.getTime()+31*60_000 >= Date.now()) tuesday = new Date(tuesday.getTime()-7*86400_000);
      const starts = [tuesday,new Date(tuesday.getTime()-7*86400_000)];
      for (const [index,id] of [missed,secondMissed].entries()) {
        await db.query(`INSERT INTO scheduled_workouts(id,user_id,routine_id,starts_at,ends_at,
          recorded_time_zone,recorded_local_date,status)
          VALUES($1,$2,$3,$4,$4::timestamptz+interval '30 min','Asia/Manila',
            ($4::timestamptz AT TIME ZONE 'Asia/Manila')::date,'planned')`,[id,owner,baseRoutine,starts[index]]);
      }
      await db.query(`INSERT INTO notification_jobs(id,user_id,type,occurrence_identity,scheduled_at,
        expires_at,schedule_revision,scheduled_workout_id)
        VALUES($1,$2,'workout_reminder','obsolete',$3,$3::timestamptz+interval '30 min',0,$4)`,
      [oldJob,owner,new Date(tuesday.getTime()-30*60_000),missed]);
      const clock = (minuteOffset) => new Date(Date.now()+8*3_600_000+minuteOffset*60_000).toISOString().slice(11,16);
      const useTomorrowWindow = untilWednesday !== 0;
      let start = '23:35', end = '23:55';
      if (!useTomorrowWindow && clock(5) < '23:30') { start = clock(5); end = clock(25); }
      const preferences = {
        expectedRevision: 0, restDays: [0,1,2,4,5,6],
        slots: [{ weekday: 3,start,end,equipment: ['Stable chair'] }],
      };
      const saved = await request('/me/availability','PUT',preferences);
      assert.equal(saved.status,200,JSON.stringify(saved));
      assert.equal(saved.data.revision,1);
      const week = scheduleResponseSchema.parse(await request('/me/scheduled-workouts')).data;
      assert.equal(week.workouts.find(item => item.id===missed).status,'missed');
      assert.deepEqual(scheduleResponseSchema.parse(await peerClient.request('/me/scheduled-workouts')).data.workouts,[]);
      const previewInput = { workoutId:missed,expectedRevision:1 };
      assert.equal((await request('/me/schedule-proposals','POST',previewInput,false)).status,403);
      assert.equal((await peerClient.request('/me/schedule-proposals','POST',{ ...previewInput,expectedRevision:0 })).status,404);
      async function preview(input) {
        const result = await request('/me/schedule-proposals','POST',input);
        assert.equal(result.status,200,JSON.stringify(result));
        return scheduleProposalResponseSchema.parse(result).data;
      }
      const { proposal } = await preview(previewInput);
      assert.ok(proposal);
      assert.equal(proposal.after.localDate,wednesday);
      assert.equal(proposal.after.variantId,variant);
      assert.match(proposal.beforeExercises[0],/3 sets/);
      assert.match(proposal.afterExercises[0],/2 sets/);
      assert.equal((await db.query('SELECT status FROM notification_jobs WHERE id=$1',[oldJob])).rows[0].status,'pending');
      const opponent = (await preview(previewInput)).proposal;
      const confirm = { expectedRevision:1,clientOperationId:randomUUID() };
      const acceptPath = id => '/me/schedule-proposals/'+id+'/accept';
      await db.query(`UPDATE notification_preferences SET time_zone_policy='fixed',fixed_time_zone='Fixture/Invalid',
        quiet_start='00:00',quiet_end='00:01'
        WHERE user_id=$1`,[owner]);
      assert.equal((await request(acceptPath(proposal.id),'POST',confirm)).status,500);
      assert.equal((await request('/me/scheduled-workouts')).data.revision,1);
      assert.deepEqual((await request('/me/scheduled-workouts')).data.workouts.find(item=>item.id===missed),proposal.before);
      assert.equal((await db.query('SELECT status FROM notification_jobs WHERE id=$1',[oldJob])).rows[0].status,'pending');
      assert.equal((await db.query('SELECT applied_at FROM schedule_proposals WHERE id=$1',[proposal.id])).rows[0].applied_at,null);
      await db.query(`UPDATE notification_preferences SET time_zone_policy='user',fixed_time_zone=NULL,
        quiet_start=NULL,quiet_end=NULL WHERE user_id=$1`,[owner]);
      const competingConfirm = { ...confirm,clientOperationId:randomUUID() };
      const [a,b] = await Promise.all([
        request(acceptPath(proposal.id),'POST',confirm),
        request(acceptPath(opponent.id),'POST',competingConfirm),
      ]);
      assert.deepEqual([a.status,b.status].sort(),[200,409],JSON.stringify([a,b]));
      const accepted = a.status===200 ? { id:proposal.id,result:a } : { id:opponent.id,result:b };
      assert.deepEqual(await request(acceptPath(accepted.id),'POST',a.status===200 ? confirm : competingConfirm),accepted.result);
      assert.equal(accepted.result.data.revision,2);
      const jobs = (await db.query(`SELECT id,status,schedule_revision,preference_revision FROM notification_jobs
        WHERE user_id=$1 AND scheduled_workout_id=$2 ORDER BY schedule_revision`,[owner,missed])).rows;
      assert.deepEqual(jobs.map(job=>job.status),['cancelled','pending']);
      assert.equal(Number(jobs[1].schedule_revision),1);
      assert.equal(Number(jobs[1].preference_revision),0);
      const noFit = await preview({ workoutId:secondMissed,expectedRevision:2 });
      assert.equal(noFit.proposal,null);
      assert.match(noFit.reason,/No compatible opening/);
      const session = await request('/me/workout-sessions','POST',{
        routineId:baseRoutine,expectedRoutineRevision:0,variantId:variant,scheduledWorkoutId:missed,
      });
      assert.equal(session.status,201,JSON.stringify(session));
      const sessionPath = '/me/workout-sessions/'+session.data.id;
      const currentWeek = scheduleResponseSchema.parse(await request('/me/scheduled-workouts')).data;
      assert.equal((await request('/me/scheduled-workouts/'+missed,'PATCH',{
        expectedRevision:currentWeek.revision,status:'cancelled',
      })).status,409);
      const set = await request(sessionPath,'PATCH',{ expectedRevision:0,action:'saveSet',exerciseIndex:0,
        set:{ setOrder:1,measurement:{ type:'bodyweight',reps:5 } } });
      assert.equal(set.status,200,JSON.stringify(set));
      const completedRequest = { expectedRevision:1,clientOperationId:randomUUID() };
      const done = await request(sessionPath+'/complete','POST',completedRequest);
      assert.equal(done.status,200,JSON.stringify(done));
      assert.deepEqual(await request(sessionPath+'/complete','POST',completedRequest),done);
      const finalWeek = scheduleResponseSchema.parse(await request('/me/scheduled-workouts')).data;
      assert.equal(finalWeek.workouts.find(workout=>workout.id===missed).status,'completed');
      assert.equal((await db.query('SELECT status FROM notification_jobs WHERE id=$1',[jobs[1].id])).rows[0].status,'cancelled');
      assert.equal((await request('/me/preferences','PATCH',{ timeZone:'UTC' })).status,200);
      const newZone = (await request('/me/availability')).data;
      assert.equal(newZone.timeZone,'UTC');
      assert.equal(newZone.revision,finalWeek.revision+1);
      assert.equal((await request('/me/availability','PUT',{ ...preferences,expectedRevision:finalWeek.revision })).status,409);
    } finally {
      await db.query('DELETE FROM notification_jobs WHERE user_id=ANY($1)',[[owner,peer]]);
      await db.query('DELETE FROM workout_sessions WHERE user_id=ANY($1)',[[owner,peer]]);
      await db.query('DELETE FROM users WHERE id=ANY($1)',[[owner,peer]]);
      await db.query('DELETE FROM workout_routines WHERE id=$1',[baseRoutine]);
    }
  } finally {
    await new Promise(resolve=>server.close(resolve));
    await db.end();
  }
});
