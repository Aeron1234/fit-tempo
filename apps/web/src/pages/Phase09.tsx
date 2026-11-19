import { useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { localDateSchema, positiveDecimalSchema, timeZoneSchema } from '@fit-tempo/contracts';
import { Button } from '@/components/ui/button';
import { preferences, preferencesResponse } from './profile-preferences';
import { mealsResponse } from './meal-response';
import { DayStrip } from '@/components/shared/DayStrip';
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
const cardStyle = 'tempo-form border border-border bg-card p-5';

function useOwner(session: Session) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return snapshot.status === 'authenticated' ? snapshot.user.id : undefined;
}

function Metric({ name, data }: {
  name: string; data: z.infer<typeof coverage> & { unit: 'kcal' | 'g' };
}) {
  return (
    <section className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 border-b border-border py-4" aria-label={name}>
      <h2 className="text-sm font-medium">{name}</h2>
      <p className="tempo-tabular text-right text-xl font-semibold">
        {data.knownSubtotal === null ? 'Unavailable' : `${data.knownSubtotal} ${data.unit}`}
      </p>
      {data.missingItemCount > 0 && (
        <p className="col-span-full text-sm text-muted-foreground">
          {data.knownSubtotal !== null && 'Known subtotal. '}
          {data.missingItemCount} {data.missingItemCount === 1 ? 'item is' : 'items are'} missing this value.
        </p>
      )}
    </section>
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
  if (failed) return <div role="alert">Meal times are unavailable. <Button type="button" variant="outline" onClick={() => void failed.refetch()}>Try again</Button></div>;
  if (pages.some(page => page.isPending)) return <p role="status">Loading meal times.</p>;
  if (next) return <div className="space-y-2">
    <p>More meals are recorded for this day.</p>
    <Button type="button" variant="outline" onClick={() => setCursors(values => [...values, next])}>Load more meal times</Button>
  </div>;
  const events = Array.from(new Map(pages.flatMap(page => page.data?.data.meals ?? []).map(meal => [meal.id, {
    id: meal.id, occurredAt: meal.occurredAt, kind: 'meal' as const,
    name: meal.mealType[0].toUpperCase() + meal.mealType.slice(1),
    amount: meal.totals.energyKcal === null ? 'Calories unavailable' :
      `${meal.totals.energyKcal} kcal${meal.missingNutrients.includes('energyKcal') ? ' known subtotal' : ''}`,
  }])).values());
  return <DayStrip date={date} timeZone={timeZone} state={state} events={events} />;
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
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        <Link to="/app/profile" className="text-sm font-medium text-accent underline underline-offset-4">Profile and preferences</Link>
      </div>
      {(dashboard.isPending || dashboard.isPlaceholderData) && <p role="status" className="text-sm">Loading nutritionâ€¦</p>}
      {dashboard.isError && (
        <div role="alert" className="text-sm space-y-3">
          <p>Nutrition could not be loaded.</p>
          <Button type="button" variant="outline" onClick={() => void dashboard.refetch()}>Try again</Button>
        </div>
      )}
      {response && (
        <>
          <section className="flex flex-wrap items-end gap-4">
            {response.meta.mode === 'synthetic-demo' ? (
              <label className="grid gap-1 text-sm font-medium">Example day
                <select className={inputStyle} value={selectedDate || response.data.date} onChange={event => setSelectedDate(event.target.value)}>
                  {response.meta.fixtureDates.map(date => <option key={date} value={date}>{date}</option>)}
                </select>
              </label>
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
              {response.meta.mode === 'synthetic-demo' && <p className="text-sm text-muted-foreground">Sample totals do not include meal times.</p>}
              <p role="status" className="text-sm">{daySummary[response.data.status]}</p>
              {response.data.status === 'complete' && response.data.itemCount === 0 &&
                response.data.calories.knownSubtotal === '0' && response.data.protein.knownSubtotal === '0' && (
                <p className="text-sm text-muted-foreground">Confirmed zero intake for this day.</p>
              )}
              <div className="border-t border-border">
                <Metric name="Calories consumed" data={response.data.calories} />
                <Metric name="Protein" data={response.data.protein} />
              </div>
            </>
          )}
        </>
      )}
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
  return (
    <form className={`${cardStyle} space-y-4`} onSubmit={handleSubmit(async fields => {
      const displayName = fields.displayName.trim();
      const heightCm = fields.heightCm.trim();
      if (!displayName) return setError('displayName', { message: 'Enter a display name.' });
      if (heightCm && !positiveDecimalSchema.safeParse(heightCm).success)
        return setError('heightCm', { message: 'Enter a positive decimal in centimeters.' });
      await save({ displayName, heightCm: heightCm || null }).catch(() => undefined);
    })}>
      <h2 className="text-xl font-semibold">Profile</h2>
      <label className="grid gap-1 text-sm font-medium">Display name
        <input className={inputStyle} maxLength={120} aria-invalid={Boolean(errors.displayName)} aria-describedby={errors.displayName ? 'displayName-error' : undefined} {...register('displayName')} />
      </label>
      {errors.displayName && <p id="displayName-error" role="alert" className="text-sm text-destructive">{errors.displayName.message}</p>}
      <label className="grid gap-1 text-sm font-medium">Height (cm, optional)
        <input className={inputStyle} inputMode="decimal" maxLength={16} aria-invalid={Boolean(errors.heightCm)} aria-describedby={errors.heightCm ? 'heightCm-error' : undefined} {...register('heightCm')} />
      </label>
      {errors.heightCm && <p id="heightCm-error" role="alert" className="text-sm text-destructive">{errors.heightCm.message}</p>}
      <Button type="submit" disabled={busy}>Save profile</Button>
    </form>
  );
}

function PreferencesForm({ value, save, busy }: {
  value: PreferencesFields; save: (value: PreferencesFields) => Promise<unknown>; busy: boolean;
}) {
  const { register, handleSubmit, setError, formState: { errors } } = useForm<PreferencesFields>({ defaultValues: value });
  return (
    <form className={`${cardStyle} space-y-4`} onSubmit={handleSubmit(async fields => {
      const parsed = preferences.safeParse({ ...fields, timeZone: fields.timeZone.trim() });
      if (!parsed.success) return setError('timeZone', { message: 'Enter a valid IANA time zone.' });
      await save(parsed.data).catch(() => undefined);
    })}>
      <h2 className="text-xl font-semibold">Preferences</h2>
      <label className="grid gap-1 text-sm font-medium">Time zone
        <input className={inputStyle} placeholder="Asia/Manila" maxLength={100} aria-invalid={Boolean(errors.timeZone)} aria-describedby={errors.timeZone ? 'timeZone-error' : undefined} {...register('timeZone')} />
      </label>
      {errors.timeZone && <p id="timeZone-error" role="alert" className="text-sm text-destructive">{errors.timeZone.message}</p>}
      <label className="grid gap-1 text-sm font-medium">Body mass unit
        <select className={inputStyle} {...register('massUnit')}><option value="kg">kg</option><option value="lb">lb</option></select>
      </label>
      <label className="grid gap-1 text-sm font-medium">Preferred theme
        <select className={inputStyle} {...register('theme')}>
          <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
        </select>
      </label>
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
      await cache.invalidateQueries({ queryKey: ['private', owner, 'dashboard'] });
    },
  });
  const failed = profileQuery.isError || preferencesQuery.isError;
  return (
    <div className="space-y-5">
      <header className="space-y-3">
        <Link to="/app" className="inline-flex min-h-11 items-center gap-2 font-medium underline underline-offset-4">
          Back to dashboard
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Profile and preferences</h1>
      </header>
      {(profileQuery.isPending || preferencesQuery.isPending) && <p role="status" className="text-sm">Loading profileâ€¦</p>}
      {failed && <div role="alert" className="text-sm space-y-3">
        <p>Profile settings could not be loaded.</p>
        <Button type="button" variant="outline" onClick={() => {
          void profileQuery.refetch();
          void preferencesQuery.refetch();
        }}>Try again</Button>
      </div>}
      <div className="grid gap-4 lg:grid-cols-2">
        {profileQuery.data && <ProfileForm value={profileQuery.data.data} busy={updateProfile.isPending} save={updateProfile.mutateAsync} />}
        {preferencesQuery.data && <PreferencesForm value={preferencesQuery.data.data}
          busy={updatePreferences.isPending} save={updatePreferences.mutateAsync} />}
      </div>
      {(updateProfile.isError || updatePreferences.isError) && <p role="alert" className="text-sm text-destructive">Settings could not be saved. Please try again.</p>}
      {(updateProfile.isSuccess || updatePreferences.isSuccess) && <p role="status" className="text-sm text-success">Settings saved.</p>}
    </div>
  );
}
