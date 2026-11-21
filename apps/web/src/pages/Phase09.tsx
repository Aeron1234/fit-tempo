import { useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { localDateSchema, positiveDecimalSchema, timeZoneSchema, waterResponseSchema } from '@fit-tempo/contracts';
import { Button } from '@/components/ui/button';
import { preferences, preferencesResponse } from './profile-preferences';
import { mealsResponse } from './meal-response';
import { DayStrip } from '@/components/shared/DayStrip';
import { GlassPanel } from '@/components/shared/GlassPanel';
import { ValuePicker } from '@/components/shared/ValuePicker';
import type { Session } from '@/lib/api/session';

const profile = z.object({ displayName: z.string().nullable(), heightCm: positiveDecimalSchema.nullable() });
const profileResponse = z.object({ data: profile });
const coverage = z.object({
  knownSubtotal: z.string().nullable(), missingItemCount: z.number().int().nonnegative(),
});
const dashboardResponse = z.object({
  data: z.object({
    date: localDateSchema, timezone: timeZoneSchema,
    status: z.enum(['unrecorded', 'partial', 'complete']),
    calories: coverage.extend({ unit: z.literal('kcal') }),
    protein: coverage.extend({ unit: z.literal('g') }), itemCount: z.number().int().nonnegative(),
  }),
  meta: z.object({ mode: z.enum(['local', 'synthetic-demo']), fixtureDates: z.array(localDateSchema) }),
});

const inputStyle = 'tempo-field w-full border border-border bg-card px-3 py-2';
const summaryStyle = 'min-h-11 cursor-pointer content-center font-medium';

function useOwner(session: Session) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return snapshot.status === 'authenticated' ? snapshot.user.id : undefined;
}

function Metric({ name, data }: {
  name: string; data: z.infer<typeof coverage> & { unit: 'kcal' | 'g' };
}) {
  return (
    <dl className="tempo-ledger tempo-dashboard-ledger" aria-label={name}>
      <dt>{name}</dt>
      <dd className="tempo-ledger-value tempo-tabular text-right">
        {data.knownSubtotal === null ? 'Unavailable' : `${data.knownSubtotal} ${data.unit}`}
      </dd>
      {data.missingItemCount > 0 && (
        <dd className="col-span-full text-sm text-muted-foreground">
          {data.knownSubtotal !== null && 'Known subtotal. '}
          {data.missingItemCount} {data.missingItemCount === 1 ? 'item is' : 'items are'} missing this value.
        </dd>
      )}
    </dl>
  );
}

const daySummary = {
  unrecorded: 'No nutrition recorded for this day.',
  partial: 'Some items recorded. This day hasnâ€™t been marked complete.',
  complete: 'Nutrition marked complete.',
};

function DashboardStrip({ session, owner, date, timeZone, state }: {
  session: Session; owner: string; date: string; timeZone: string; state: 'unrecorded' | 'partial' | 'complete';
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const pages = useQueries({ queries: [undefined, ...cursors].map(cursor => ({
    queryKey: ['private', owner, 'meals', date, cursor],
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      const params = new URLSearchParams({ date });
      if (cursor) params.set('cursor', cursor);
      return session.requestPrivate(`/me/meals?${params}`, mealsResponse.parse, signal);
    },
    retry: false,
  })) });
  const failed = pages.find(page => page.isError);
  const next = pages.at(-1)?.data?.data.nextCursor;
  if (failed) return <GlassPanel title="Day strip"><div role="alert">Meal times are unavailable. <Button type="button" variant="outline" onClick={() => void failed.refetch()}>Try again</Button></div></GlassPanel>;
  if (pages.some(page => page.isPending)) return <GlassPanel title="Day strip"><p role="status">Loading meal times.</p></GlassPanel>;
  if (next) return <GlassPanel title="Day strip"><div className="space-y-2">
    <p>More meals are recorded for this day.</p>
    <Button type="button" variant="outline" onClick={() => setCursors(values => [...values, next])}>Load more meal times</Button>
  </div></GlassPanel>;
  const events = Array.from(new Map(pages.flatMap(page => page.data?.data.meals ?? []).map(meal => [meal.id, {
    id: meal.id, occurredAt: meal.occurredAt, kind: 'meal' as const,
    name: meal.mealType[0].toUpperCase() + meal.mealType.slice(1),
    amount: meal.totals.energyKcal === null ? 'Calories unavailable' :
      `${meal.totals.energyKcal} kcal${meal.missingNutrients.includes('energyKcal') ? ' known subtotal' : ''}`,
  }])).values());
  return <DayStrip panel date={date} timeZone={timeZone} state={state} events={events} />;
}

function DashboardWater({ session, owner, date }: { session: Session; owner: string; date: string }) {
  const water = useQuery({
    queryKey: ['private', owner, 'water', date],
    queryFn: ({ signal }) => session.requestPrivate('/me/water?date=' + encodeURIComponent(date), waterResponseSchema.parse, signal),
    retry: false,
  });
  const total = water.data?.data.totalMl;
  return <GlassPanel title="Hydration" tone="solid" action={<Link className="inline-flex min-h-11 items-center text-sm text-accent underline" to="/app/goals">Log water</Link>}>
    <p>{water.isPending ? 'Loading water entries…' : water.isError ? 'Water entries unavailable.' : total == null ? 'No water recorded for this day.' : total + ' mL recorded'}</p>
  </GlassPanel>;
}

export function DashboardPage({ session }: { session: Session }) {
  const owner = useOwner(session);
  const [selectedDate, setSelectedDate] = useState('');
  const dashboard = useQuery({
    queryKey: ['private', owner, 'dashboard', selectedDate],
    queryFn: ({ signal }) => session.requestPrivate(
      `/me/dashboard${selectedDate ? `?date=${encodeURIComponent(selectedDate)}` : ''}`, dashboardResponse.parse, signal,
    ),
    enabled: Boolean(owner), retry: false, placeholderData: keepPreviousData,
  });
  const response = dashboard.data;
  return (
    <div className="tempo-dashboard">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Today</h1>
        {response && !dashboard.isPlaceholderData && <p role="status" className="text-sm text-muted-foreground">{daySummary[response.data.status]}</p>}
        <Button asChild><Link to="/app/meals">Log a meal</Link></Button>
      </header>
      {(dashboard.isPending || dashboard.isPlaceholderData) && <GlassPanel title="Nutrition"><p role="status">Loading nutrition.</p></GlassPanel>}
      {dashboard.isError && (
        <GlassPanel title="Nutrition"><div role="alert" className="text-sm space-y-3">
          <p>Nutrition could not be loaded.</p>
          <Button type="button" variant="outline" onClick={() => void dashboard.refetch()}>Try again</Button>
        </div></GlassPanel>
      )}
      {response && (
        <>
          <section className="flex flex-wrap items-end gap-4">
            {response.meta.mode === 'synthetic-demo' ? (
              <ValuePicker id="dashboard-example-day" label="Example day" value={selectedDate || response.data.date}
                onValueChange={setSelectedDate} options={response.meta.fixtureDates.map(date => ({ value: date, label: date }))} />
            ) : (
              <label className="grid w-full max-w-60 gap-1 text-sm font-semibold">
                Date
                <input type="date" className={inputStyle} value={selectedDate || response.data.date}
                  onChange={event => {
                    const value = event.target.value;
                    if (!value || localDateSchema.safeParse(value).success) setSelectedDate(value);
                  }} />
              </label>
            )}
            {!dashboard.isPlaceholderData && (
              <p className="text-sm text-muted-foreground pb-2">Day time zone: {response.data.timezone}</p>
            )}
          </section>
          {response.meta.mode === 'synthetic-demo' && <p className="text-sm text-muted-foreground">Showing sample nutrition data.</p>}
          {!dashboard.isPlaceholderData && (
            <>
              {owner && response.meta.mode !== 'synthetic-demo' &&
                <DashboardStrip key={`${owner}/${response.data.date}`} session={session} owner={owner}
                  date={response.data.date} timeZone={response.data.timezone} state={response.data.status} />}
              <div className="tempo-dashboard-panels">
                <GlassPanel title="Nutrition">
                  {response.meta.mode === 'synthetic-demo' && <p className="text-sm text-muted-foreground">Sample totals do not include meal times.</p>}
                  {response.data.status === 'complete' && response.data.itemCount === 0 &&
                    response.data.calories.knownSubtotal === '0' && response.data.protein.knownSubtotal === '0' && (
                    <p className="text-sm text-muted-foreground">Confirmed zero intake for this day.</p>
                  )}
                  <div className="mt-3">
                    <Metric name="Calories consumed" data={response.data.calories} />
                    <Metric name="Protein" data={response.data.protein} />
                  </div>
                </GlassPanel>
                {owner && response.meta.mode !== 'synthetic-demo' && <DashboardWater session={session} owner={owner} date={response.data.date} />}
              </div>
            </>
          )}
        </>
      )}
      <details>
        <summary className={summaryStyle}>More about your day</summary>
        <div className="flex flex-wrap gap-x-4">
          <Link to="/app/week" className="inline-flex min-h-11 items-center text-sm font-medium text-accent underline underline-offset-4">View workout schedule</Link>
          <Link to="/app/analytics" className="inline-flex min-h-11 items-center text-sm font-medium text-accent underline underline-offset-4">Weekly analytics</Link>
          <Link to="/app/profile" className="inline-flex min-h-11 items-center text-sm font-medium text-accent underline underline-offset-4">Profile and preferences</Link>
        </div>
      </details>
    </div>
  );
}

type ProfileFields = { displayName: string; heightCm: string };
type PreferencesFields = z.infer<typeof preferences>;

function ProfileForm({ value, save, busy }: {
  value: z.infer<typeof profile>;
  save: (value: { displayName: string; heightCm: string | null }) => Promise<unknown>;
  busy: boolean;
}) {
  const { register, handleSubmit, setError, formState: { errors } } = useForm<ProfileFields>({
    defaultValues: { displayName: value.displayName ?? '', heightCm: value.heightCm ?? '' },
  });
  const heightOptions = useRef<HTMLDetailsElement>(null);
  return (
    <form className="space-y-4" onSubmit={event => {
      void handleSubmit(async fields => {
        const displayName = fields.displayName.trim();
        const heightCm = fields.heightCm.trim();
        if (!displayName) return setError('displayName', { message: 'Enter a display name.' });
        if (heightCm && !positiveDecimalSchema.safeParse(heightCm).success) {
          if (heightOptions.current) heightOptions.current.open = true;
          return setError('heightCm', { message: 'Enter a positive decimal in centimeters.' }, { shouldFocus: true });
        }
        await save({ displayName, heightCm: heightCm || null }).catch(() => undefined);
      })(event);
    }}>
      <label className="grid gap-1 text-sm font-medium">Display name
        <input className={inputStyle} maxLength={120} aria-invalid={Boolean(errors.displayName)} aria-describedby={errors.displayName ? 'displayName-error' : undefined} {...register('displayName')} />
      </label>
      {errors.displayName && <p id="displayName-error" role="alert" className="text-sm text-destructive">{errors.displayName.message}</p>}
      <details ref={heightOptions} className="space-y-2 border-y border-border">
        <summary className={summaryStyle}>Height (optional)</summary>
        <label className="grid gap-1 text-sm font-medium">Height (cm)
          <input className={inputStyle} inputMode="decimal" maxLength={16} aria-invalid={Boolean(errors.heightCm)} aria-describedby={errors.heightCm ? 'heightCm-error' : undefined} {...register('heightCm')} />
        </label>
        {errors.heightCm && <p id="heightCm-error" role="alert" className="text-sm text-destructive">{errors.heightCm.message}</p>}
      </details>
      <Button type="submit" disabled={busy}>Save profile</Button>
    </form>
  );
}

function PreferencesForm({ value, save, busy }: {
  value: PreferencesFields; save: (value: PreferencesFields) => Promise<unknown>; busy: boolean;
}) {
  const { register, control, handleSubmit, setError, formState: { errors } } = useForm<PreferencesFields>({ defaultValues: value });
  return (
    <form className="space-y-4" onSubmit={handleSubmit(async fields => {
      const parsed = preferences.safeParse({ ...fields, timeZone: fields.timeZone.trim() });
      if (!parsed.success) return setError('timeZone', { message: 'Enter a valid IANA time zone.' });
      await save(parsed.data).catch(() => undefined);
    })}>
      <label className="grid gap-1 text-sm font-medium">Time zone
        <input className={inputStyle} placeholder="Asia/Manila" maxLength={100} aria-invalid={Boolean(errors.timeZone)} aria-describedby={errors.timeZone ? 'timeZone-error' : undefined} {...register('timeZone')} />
      </label>
      {errors.timeZone && <p id="timeZone-error" role="alert" className="text-sm text-destructive">{errors.timeZone.message}</p>}
      <Controller control={control} name="massUnit" render={({ field }) => <ValuePicker id="profile-mass-unit" label="Body mass unit"
        value={field.value} onValueChange={field.onChange} options={[{ value: 'kg', label: 'kg' }, { value: 'lb', label: 'lb' }]} />} />
      <Controller control={control} name="theme" render={({ field }) => <ValuePicker id="profile-theme" label="Preferred theme"
        value={field.value} onValueChange={field.onChange} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />} />
      <Button type="submit" disabled={busy}>Save preferences</Button>
    </form>
  );
}

export function ProfilePage({ session }: { session: Session }) {
  const owner = useOwner(session);
  const cache = useQueryClient();
  const profileKey = ['private', owner, 'profile'];
  const preferencesKey = ['private', owner, 'preferences'];
  function stillOwned() {
    const snapshot = session.getSnapshot();
    return snapshot.status === 'authenticated' && snapshot.user.id === owner;
  }
  const profileQuery = useQuery({
    queryKey: profileKey, enabled: Boolean(owner), retry: false,
    queryFn: ({ signal }) => session.requestPrivate('/me/profile', profileResponse.parse, signal),
  });
  const preferencesQuery = useQuery({
    queryKey: preferencesKey, enabled: Boolean(owner), retry: false,
    queryFn: ({ signal }) => session.requestPrivate('/me/preferences', preferencesResponse.parse, signal),
  });
  const updateProfile = useMutation({
    mutationFn: (body: { displayName: string; heightCm: string | null }) =>
      session.mutatePrivate('/me/profile', body, profileResponse.parse),
    onSuccess: data => {
      if (stillOwned()) cache.setQueryData(profileKey, data);
    },
  });
  const updatePreferences = useMutation({
    mutationFn: (body: PreferencesFields) =>
      session.mutatePrivate('/me/preferences', body, preferencesResponse.parse),
    onSuccess: async data => {
      if (!stillOwned()) return;
      cache.setQueryData(preferencesKey, data);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['private', owner, 'dashboard'] }),
        cache.invalidateQueries({ queryKey: ['private', owner, 'notification-preferences'] }),
      ]);
    },
  });
  return (
    <div className="tempo-card-grid min-w-0">
      <header className="space-y-3">
        <Link to="/app" className="inline-flex min-h-11 items-center gap-2 font-medium underline underline-offset-4">
          Back to dashboard
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Profile and preferences</h1>
      </header>

      <div className="grid items-start gap-4 md:gap-5 lg:grid-cols-2">
        <GlassPanel title="Profile" tone="solid">
          {profileQuery.isPending && <p role="status">Loading profile.</p>}
          {profileQuery.isError && <div role="alert" className="space-y-2">
            <p>Profile settings could not be loaded.</p>
            <Button type="button" variant="outline" onClick={() => void profileQuery.refetch()}>Try again</Button>
          </div>}
          {profileQuery.data && <ProfileForm value={profileQuery.data.data} busy={updateProfile.isPending} save={updateProfile.mutateAsync} />}
        </GlassPanel>
        <GlassPanel title="Preferences" tone="solid">
          {preferencesQuery.isPending && <p role="status">Loading preferences.</p>}
          {preferencesQuery.isError && <div role="alert" className="space-y-2">
            <p>Preferences could not be loaded.</p>
            <Button type="button" variant="outline" onClick={() => void preferencesQuery.refetch()}>Try again</Button>
          </div>}
          {preferencesQuery.data && <PreferencesForm value={preferencesQuery.data.data}
            busy={updatePreferences.isPending} save={updatePreferences.mutateAsync} />}
        </GlassPanel>
      </div>
      <Link to="/app/notifications" className="inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-4">
        Email notifications
      </Link>
      {(updateProfile.isError || updatePreferences.isError) && <p role="alert" className="text-sm text-destructive">Settings could not be saved. Please try again.</p>}
      {(updateProfile.isSuccess || updatePreferences.isSuccess) && <p role="status" className="text-sm text-success">Settings saved.</p>}
    </div>
  );
}
