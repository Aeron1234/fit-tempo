import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { activityResponseSchema, measurementsResponseSchema, weightResponseSchema, workoutSessionsResponseSchema } from '@fit-tempo/contracts';
import { Button } from '@/components/ui/button';
import { ComposedChart, Line, Scatter, XAxis, YAxis } from 'recharts';
import { ChartCard } from '@/components/shared/ChartCard';
import { ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { ValuePicker } from '@/components/shared/ValuePicker';
import { UnrecordedHatch } from '@/components/shared/UnrecordedHatch';
import { GlassPanel } from '@/components/shared/GlassPanel';
import type { Session } from '@/lib/api/session';
import { mealWallTime } from './meal-form';
import { parseTrackingForm, type TrackingKind as Kind } from './activity-progress-form';
import { preferencesResponse } from './profile-preferences';

type Entry = ReturnType<typeof activityResponseSchema.parse>['data']['entries'][number];
type Point = { date: string; value: string };
const schemas = { activity: activityResponseSchema, weight: weightResponseSchema, measurements: measurementsResponseSchema };
const label = 'flex flex-col gap-1 text-sm font-medium';
const field = 'tempo-field min-h-11 px-3 py-2';

function dateRange(from: string, to: string) {
  const days: string[] = [];
  for (let date = Date.parse(from); date <= Date.parse(to); date += 86_400_000) days.push(new Date(date).toISOString().slice(0, 10));
  return days;
}

function Trend({ title, unit, from, to, points }: { title: string; unit: string; from: string; to: string; points: Point[] }) {
  const values = new Map<string, string[]>();
  for (const point of points) values.set(point.date, [...(values.get(point.date) ?? []), point.value]);
  const days = dateRange(from, to);
  const daily = days.map((date, index) => {
    const observations = values.get(date);
    return { index, amount: observations?.length === 1 ? Number(observations[0]) : null };
  });
  const observations = days.flatMap((date, index) =>
    (values.get(date)?.length === 1 ? [] : values.get(date) ?? []).map(amount => ({ index, amount: Number(amount) })));
  const footer = <div className="space-y-1">
    <p className="text-sm text-muted-foreground">{from} to {to}. Gaps indicate days without a value in this view.</p>
    {points.length > 0 && <p className="text-sm">Dots show observations. A line joins consecutive days with one reading each.</p>}
    {points.length > 0 && <details className="text-sm"><summary className="min-h-11 cursor-pointer py-3">View dates and values</summary>
      <dl className="grid grid-cols-[1fr_auto] gap-1">
        {days.map(date => <div key={date} className="contents"><dt>{date}</dt><dd>{values.get(date)?.map(amount => amount + ' ' + unit).join(', ') ?? 'Not recorded'}</dd></div>)}
      </dl>
    </details>}
  </div>;
  if (points.length === 0) return <GlassPanel title={title + ' (' + unit + ')'} tone="solid" footer={footer}>
    <UnrecordedHatch /><p className="text-sm">No values recorded in this period.</p>
  </GlassPanel>;
  const tickDates = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];
  return <ChartCard title={title + ' (' + unit + ')'} tone="solid" footer={footer}
    config={{ amount: { label: 'Recorded amount', color: 'var(--chart-2)' } }}>
    <ComposedChart data={daily} accessibilityLayer aria-label={title + ' (' + unit + ')'}>
      <XAxis type="number" dataKey="index" domain={[0, Math.max(1, days.length - 1)]}
        ticks={tickDates} tick={{ fontSize: 12 }} tickFormatter={(index: number) => days[index]?.slice(5) ?? ''} />
      <YAxis dataKey="amount" type="number" tick={{ fontSize: 12 }} domain={['auto', 'auto']} width={45} />
      <ChartTooltip content={hover => {
        const index = Number(hover.label ?? hover.payload[0]?.payload?.index);
        const date = days[index];
        return <ChartTooltipContent {...hover} payload={hover.payload.slice(0, 1)} label={date}
          className="bg-card text-foreground"
          formatter={() => <span className="tabular-nums">{values.get(date)?.map(amount => amount + ' ' + unit).join(', ') ?? 'Not recorded'}</span>} />;
      }} />
      <Line dataKey="amount" type="linear" stroke="var(--color-amount)" strokeWidth={2} connectNulls={false} dot={{ r: 3 }} isAnimationActive={false} />
      <Scatter data={observations} dataKey="amount" fill="var(--color-amount)" isAnimationActive={false} />
    </ComposedChart>
  </ChartCard>;
}

function Tracking({ session, owner }: { session: Session; owner: string }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<Entry | null>(null);
  const [linkedWorkout, setLinkedWorkout] = useState('');
  const [activityType, setActivityType] = useState('walking');
  const key = ['private', owner, 'activity-progress'];
  const activity = useQuery({ queryKey: [...key, 'activity'], queryFn: ({ signal }) => session.requestPrivate('/me/activity', schemas.activity.parse, signal), retry: false });
  const weight = useQuery({ queryKey: [...key, 'weight'], queryFn: ({ signal }) => session.requestPrivate('/me/weight', schemas.weight.parse, signal), retry: false });
  const measurements = useQuery({ queryKey: [...key, 'measurements'], queryFn: ({ signal }) => session.requestPrivate('/me/measurements', schemas.measurements.parse, signal), retry: false });
  const preferences = useQuery({ queryKey: [...key, 'preferences'], queryFn: ({ signal }) => session.requestPrivate('/me/preferences', preferencesResponse.parse, signal), retry: false });
  const workouts = useQuery({ queryKey: [...key, 'workouts'], queryFn: ({ signal }) => session.requestPrivate('/me/workout-sessions', workoutSessionsResponseSchema.parse, signal), retry: false });
  const zone = preferences.data?.data.timeZone;
  const write = useMutation({
    mutationFn: ({ kind, body, id }: { kind: Kind; body: object; id?: string }) =>
      session.mutateMeal(id ? 'PATCH' : 'POST', '/me/' + kind + (id ? '/' + id : ''), body, value => value),
    onSuccess: async () => {
      setNotice('Entry saved.');
      if (editing) setActivityType('walking');
      setEditing(null);
      setLinkedWorkout('');
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: failure => setError(failure instanceof Error ? failure.message : 'Unable to save this entry.'),
  });

  function submit(event: FormEvent<HTMLFormElement>, kind: Kind) {
    event.preventDefault();
    setError('');
    setNotice('');
    const form = new FormData(event.currentTarget);
    const linked = kind === 'activity' ? String(form.get('workout') ?? '') : '';
    const parsed = zone && parseTrackingForm(kind, form, zone, completed.find(item => item.id === linked)?.startedAt);
    if (!parsed || !parsed.success) {
      setError(parsed ? parsed.message : 'Your time zone is unavailable.');
      return;
    }
    write.mutate({ kind, body: parsed.data, ...(kind === 'activity' && editing ? { id: editing.id } : {}) });
  }

  const clock = (when: string, timeZone: string) => mealWallTime(when, timeZone).replace('T', ' ');
  const completed = workouts.data?.data.filter(item => item.status === 'completed') ?? [];
  const measurementsByType = new Map<string, Point[]>();
  for (const item of measurements.data?.data.entries ?? []) {
    const points = measurementsByType.get(item.measurementType) ?? [];
    points.push({ date: item.localDate, value: item.valueCm });
    measurementsByType.set(item.measurementType, points);
  }
  const dateField = (when?: string) => <label className={label}>Local date and time{zone ? ' (' + zone + ')' : ''}
    <input required type="datetime-local" className={field} name="date" defaultValue={zone ? mealWallTime(when ?? new Date().toISOString(), zone) : ''} />
  </label>;

  return <div className="tempo-card-grid min-w-0">
    <header><h1 className="text-3xl font-semibold">Activity and body tracking</h1>
      <p className="text-muted-foreground">Manual entry works without device permissions. Fit Tempo does not read location, motion sensors or wearables here, and a browser cannot reliably count steps or track activity while closed.</p></header>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {preferences.isError && <p role="alert">Could not load your time zone. <Button variant="outline" onClick={() => void preferences.refetch()}>Retry</Button></p>}
    <div key={zone ?? 'no-zone'} className="grid items-start gap-4 lg:grid-cols-2">
      <GlassPanel tone="solid"><form key={editing?.id ?? 'new'} className="space-y-3" onSubmit={event => submit(event, 'activity')}>
        <h2 className="text-xl font-semibold">{editing ? 'Edit activity' : 'Log activity'}</h2>
        <ValuePicker label="Activity type" name="type" value={activityType} onValueChange={setActivityType}
          options={[
            { value: 'walking', label: 'Walking' }, { value: 'running', label: 'Running' },
            { value: 'cycling', label: 'Cycling' }, { value: 'other', label: 'Other' },
          ]} />
        <fieldset disabled={Boolean(linkedWorkout)} className="space-y-3">
        {dateField(editing?.occurredAt)}
        <label className={label}>Duration (seconds)<input name="seconds" type="number" min="1" step="1" className={field} defaultValue={editing?.durationSeconds ?? ''} /></label>
        <label className={label}>Distance (m)<input name="meters" inputMode="decimal" className={field} defaultValue={editing?.distanceMeters ?? ''} /></label>
        </fieldset>
        <ValuePicker name="workout" label="Link to a completed workout (optional)" placeholder="No link"
          value={linkedWorkout} onValueChange={setLinkedWorkout} searchable loading={workouts.isPending}
          options={[{ value: '', label: 'No link' }, ...completed.map(item => ({
            value: item.id, label: item.snapshot.name + ' - ' + (zone ? clock(item.startedAt, zone) : item.startedAt),
          }))]} />
        {workouts.isError && <p className="text-sm">Workout links are unavailable. Manual activity can still be logged.</p>}
        <p className="text-sm text-muted-foreground">{linkedWorkout ? 'The workout supplies the date and duration. This link is excluded from standalone totals.' : 'Provide a duration or distance. Linking a workout keeps it out of standalone totals.'}</p>
        <div className="flex flex-wrap gap-2"><Button disabled={!zone || write.isPending}>{editing ? 'Save activity' : 'Log activity'}</Button>
          {editing && <Button type="button" variant="outline" onClick={() => { setEditing(null); setActivityType('walking'); setLinkedWorkout(''); }}>Cancel edit</Button>}</div>
      </form></GlassPanel>
      <GlassPanel tone="solid"><form className="space-y-3" onSubmit={event => submit(event, 'weight')}>
        <h2 className="text-xl font-semibold">Log weight</h2>{dateField()}
        <label className={label}>Weight (kg)<input required name="kg" className={field} inputMode="decimal" /></label>
        <label className={label}>Note (optional)<input name="note" className={field} maxLength={1000} /></label>
        <Button disabled={!zone || write.isPending}>Log weight</Button>
      </form></GlassPanel>
      <GlassPanel tone="solid"><form className="space-y-3" onSubmit={event => submit(event, 'measurements')}>
        <h2 className="text-xl font-semibold">Log a body measurement</h2>{dateField()}
        <label className={label}>Measurement type<input required name="type" className={field} maxLength={80} placeholder="e.g. waist" /></label>
        <label className={label}>Value (cm)<input required name="cm" inputMode="decimal" className={field} /></label>
        <Button disabled={!zone || write.isPending}>Log measurement</Button>
      </form></GlassPanel>
    </div>
    <GlassPanel title="Activity history">
      {activity.isPending && <LoadingSkeleton label="Loading activity history." shape="rows" />}
      {activity.isError && <p role="alert">Activity history is unavailable.</p>}
      {activity.data && (() => {
        const { entries, totals } = activity.data.data;
        return <div className="space-y-3">
          {activity.data?.data.truncated && <p className="text-sm">History display is limited to the most recent entries in this period.</p>}
          <p>{totals.manualCount} standalone Ã‚Â· {totals.linkedCount} linked. Standalone totals: {totals.durationSeconds === null ? 'No duration recorded' : totals.durationSeconds + ' s'} Ã‚Â· {totals.distanceMeters === null ? 'No distance recorded' : totals.distanceMeters + ' m'}</p>
          <ul className="space-y-1">{entries.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-1">
            <span>{clock(item.occurredAt, item.timeZone)} ({item.timeZone}) Ã‚Â· {item.type} Ã‚Â· {item.durationSeconds ?? 'Unknown'} s Ã‚Â· {item.distanceMeters ?? 'Unknown'} m{item.source === 'workout' && ' Ã‚Â· Linked workout; excluded from standalone totals'}</span>
            <Button variant="outline" disabled={write.isPending || (item.linkedWorkoutId !== null && !completed.some(workout => workout.id === item.linkedWorkoutId))} onClick={() => { setEditing(item); setActivityType(item.type); setLinkedWorkout(item.linkedWorkoutId ?? ''); }}>Edit</Button>
          </li>)}</ul>
        </div>;
      })()}
    </GlassPanel>
    <div className="grid items-start gap-4 md:gap-5 lg:grid-cols-2">
      {activity.data && <Trend title="Standalone activity observations" unit="m" from={activity.data.data.from} to={activity.data.data.to}
        points={activity.data.data.entries.flatMap(item => item.source === 'manual' && item.distanceMeters !== null ? [{ date: item.localDate, value: item.distanceMeters }] : [])} />}
      {weight.isPending && <GlassPanel title="Weight trend" tone="solid"><LoadingSkeleton label="Loading weight history." shape="chart" /></GlassPanel>}
      {weight.isError && <GlassPanel title="Weight trend" tone="solid"><p role="alert">Weight history is unavailable.</p></GlassPanel>}
      {weight.data && <Trend title="Recorded weight" unit="kg" from={weight.data.data.from} to={weight.data.data.to}
        points={weight.data.data.entries.map(item => ({ date: item.localDate, value: item.weightKg }))} />}
      {measurements.isPending && <GlassPanel title="Measurement trends" tone="solid"><LoadingSkeleton label="Loading measurement history." shape="chart" /></GlassPanel>}
      {measurements.isError && <GlassPanel title="Measurement trends" tone="solid"><p role="alert">Measurement history is unavailable.</p></GlassPanel>}
      {measurements.data && (measurementsByType.size
        ? [...measurementsByType].map(([type, points]) => <Trend key={type} title={type} unit="cm" from={measurements.data.data.from} to={measurements.data.data.to} points={points} />)
        : <GlassPanel title="Measurement trends" tone="solid"><UnrecordedHatch /><p>No body measurements recorded in this period.</p></GlassPanel>)}
    </div>
  </div>;
}

export function ActivityProgressPage({ session }: { session: Session }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return snapshot.status === 'authenticated' ? <Tracking key={snapshot.user.id} session={session} owner={snapshot.user.id} /> : null;
}
