import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { useState, useSyncExternalStore, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { analyticsResponseSchema, type AnalyticsWeek } from '@fit-tempo/contracts'
import { Bar, BarChart, XAxis, YAxis } from 'recharts'
import { ChartCard } from '@/components/shared/ChartCard'
import { ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { UnrecordedHatch } from '@/components/shared/UnrecordedHatch'
import { GlassPanel } from '@/components/shared/GlassPanel'
import { Button } from '@/components/ui/button'
import type { Session } from '@/lib/api/session'

const value = (amount: string | number | null, unit: string) => amount === null ? 'Unavailable' : amount + ' ' + unit

function Trend({ week, kind }: { week: AnalyticsWeek; kind: 'calories' | 'water' }) {
  const title = kind === 'calories' ? 'Known calorie subtotal' : 'Recorded water'
  const heading = kind === 'calories' ? 'Nutrition by date' : 'Hydration by date'
  const unit = kind === 'calories' ? 'kcal' : 'mL'
  const days = week.days.map(day => ({
    date: day.date, amount: kind === 'calories' ? day.nutrition.calories.knownSubtotal : day.waterMl,
    missing: kind === 'calories' ? day.nutrition.calories.missingItemCount : 0,
  }))
  const chart = days.map(day => ({ date: day.date, amount: day.amount === null ? null : Number(day.amount) }))
  const footer = <details className="text-sm">
    <summary className="min-h-11 cursor-pointer py-3 font-medium">View dates, values and coverage</summary>
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
      {days.map(day => <div key={day.date} className="contents">
        <dt><time dateTime={day.date} className="tempo-tabular">{day.date}</time></dt>
        <dd className="text-right">{day.amount === null ? (day.missing ? 'Unavailable' : 'Not recorded') : day.amount + ' ' + unit}
          {day.missing > 0 && <span className="block text-muted-foreground">{day.missing} missing</span>}</dd>
      </div>)}
    </dl>
  </details>
  if (chart.every(day => day.amount === null)) return <GlassPanel title={heading} tone="solid" footer={footer}>
    <UnrecordedHatch /><p className="text-sm">Not recorded</p>
  </GlassPanel>
  return <ChartCard title={heading} tone="solid" config={{ amount: { label: title, color: 'var(--chart-2)' } }} footer={footer}>
    <BarChart data={chart} accessibilityLayer aria-label={title + ' (' + unit + ')'}>
      <XAxis dataKey="date" tick={{ fontSize: 12 }} tickFormatter={(date: string) => date.slice(5)} minTickGap={14} />
      <YAxis tick={{ fontSize: 12 }} width={44} unit={' ' + unit} />
      <ChartTooltip content={hover => <ChartTooltipContent {...hover}
        className="bg-card text-foreground"
        formatter={() => <span className="tabular-nums">{value(days.find(day => day.date === hover.label)?.amount ?? null, unit)}</span>} />} />
      <Bar dataKey="amount" fill="var(--color-amount)" fillOpacity={0.8} stroke="var(--color-amount)" isAnimationActive={false}
        minPointSize={amount => amount === 0 ? 2 : 0} />
    </BarChart>
  </ChartCard>
}

function WeekSummary({ heading, week }: { heading: string; week: AnalyticsWeek }) {
  const { nutrition, hydration, activity, workouts, weight } = week
  return <section className="space-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
    <h3 className="font-semibold">{heading}</h3>
    <p className="tempo-tabular text-sm text-muted-foreground">{week.from} to {week.to}</p>
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-sm">
      <dt>Calories average on {nutrition.loggedDays} logged days</dt><dd>{value(nutrition.calories.average, 'kcal')}</dd>
      <dt>Protein average on {nutrition.loggedDays} logged days</dt><dd>{value(nutrition.protein.average, 'g')}</dd>
      <dt>Water average on {hydration.loggedDays} logged days</dt><dd>{value(hydration.averageMl, 'mL')}</dd>
      <dt>Completed workouts</dt><dd>{workouts.completedCount}</dd>
      <dt>Recorded workout time</dt><dd>{value(workouts.durationSeconds, 's')}</dd>
      <dt>Standalone activity time</dt><dd>{value(activity.durationSeconds, 's')}</dd>
      <dt>Standalone distance</dt><dd>{value(activity.distanceMeters, 'm')}</dd>
      <dt>Linked activities excluded</dt><dd>{activity.linkedExcludedCount}</dd>
      <dt>Weight change</dt><dd>{value(weight.changeKg, 'kg')}</dd>
    </dl>
    <p className="text-sm text-muted-foreground">Calories known on {nutrition.calories.knownDays} days. {nutrition.calories.missingItemCount} items missing calories. Protein known on {nutrition.protein.knownDays} days. {nutrition.protein.missingItemCount} items missing protein.</p>
    {(nutrition.calories.missingItemCount > 0 || nutrition.protein.missingItemCount > 0) &&
      <p className="text-sm text-muted-foreground">The nutrition averages reflect only known amounts and may understate intake.</p>}
    {(workouts.missingDurationCount > 0 || workouts.overlapCount > 0) && <p className="text-sm text-muted-foreground">{workouts.missingDurationCount} workouts missing duration. {workouts.overlapCount} overlapping workouts excluded from time.</p>}
    {(activity.missingDurationCount > 0 || activity.missingDistanceCount > 0) && <p className="text-sm text-muted-foreground">{activity.missingDurationCount} activities missing duration. {activity.missingDistanceCount} missing distance.</p>}
    {weight.start && weight.end && weight.changeKg !== null
      ? <p className="text-sm">Measured {weight.start.kg} kg on {weight.start.date} and {weight.end.kg} kg on {weight.end.date}. Uses the earliest reading in the first three days and the latest in the last three.</p>
      : <p className="text-sm text-muted-foreground">Weight change needs comparable measurements in both the first three and last three days of the week.</p>}
  </section>
}

function PrivateAnalytics({ owner, session }: { owner: string; session: Session }) {
  const [weekStart, setWeekStart] = useState('')
  const [error, setError] = useState('')
  const query = useQuery({
    queryKey: ['private', owner, 'weekly-analytics', weekStart], retry: false,
    queryFn: ({ signal }) => {
      const weekEnd = weekStart ? new Date(Date.parse(weekStart) + 6 * 86_400_000).toISOString().slice(0, 10) : ''
      const suffix = weekStart ? '?' + new URLSearchParams({ from: weekStart, to: weekEnd }) : ''
      return session.requestPrivate('/me/analytics' + suffix, analyticsResponseSchema.parse, signal)
    },
  })
  function selectWeek(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const start = String(new FormData(event.currentTarget).get('start'))
    if (!Number.isFinite(Date.parse(start)) || new Date(start).getUTCDay() !== 1) {
      setError('Choose a Monday to view a complete week.'); return
    }
    setError('')
    setWeekStart(start)
  }
  const result = query.data?.data
  return <div className="tempo-card-grid min-w-0">
    <header><h1 className="text-3xl font-semibold">Weekly analytics</h1>
      <p className="text-muted-foreground">Compare two complete Monday to Sunday weeks. Missing data stays visible.</p></header>
    <form onSubmit={selectWeek} className="tempo-form flex flex-wrap items-end gap-3">
      <label className="grid gap-1">Week starting Monday<input name="start" type="date" required className="tempo-field px-2" /></label>
      <Button type="submit">View week</Button>
      {weekStart && <Button type="button" variant="outline" onClick={() => { setError(''); setWeekStart('') }}>Latest complete week</Button>}
    </form>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {query.isPending && <>
      <GlassPanel title="Week comparison"><LoadingSkeleton label="Loading weekly metrics." shape="ledger" count={6} /></GlassPanel>
      <div className="tempo-dashboard-panels">
        <GlassPanel title="Nutrition by date" tone="solid"><LoadingSkeleton label="Loading nutrition trend." shape="chart" /></GlassPanel>
        <GlassPanel title="Hydration by date" tone="solid"><LoadingSkeleton label="Loading hydration trend." shape="chart" /></GlassPanel>
      </div>
    </>}
    {query.isError && <GlassPanel title="Week comparison" tone="solid"><p role="alert" className="text-destructive">{query.error instanceof Error ? query.error.message : 'Weekly metrics are unavailable.'}</p></GlassPanel>}
    {result && <>
      <p className="text-sm text-muted-foreground">Week boundaries use {result.timeZone}. Nutrition and water averages use their logged days. Missing nutrient values are excluded from the known subtotal.</p>
      <GlassPanel title="Week comparison"><div className="space-y-4"><WeekSummary heading="Selected week" week={result.current} />
        <WeekSummary heading="Previous week" week={result.previous} /></div></GlassPanel>
      <div className="tempo-dashboard-panels">
        <Trend week={result.current} kind="calories" />
        <Trend week={result.current} kind="water" />
      </div>
    </>}
  </div>
}

export function AnalyticsPage({ session }: { session: Session }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  return snapshot.status === 'authenticated' ? <PrivateAnalytics key={snapshot.user.id} owner={snapshot.user.id} session={session} /> : null
}
