import { useEffect, useMemo, useState } from 'react'
import { getDayBounds, hour } from './day-strip-time'
import { UnrecordedHatch } from './UnrecordedHatch'

export type DayEvent = {
  id: string
  occurredAt: string
  kind: 'meal' | 'water' | 'workout' | 'activity'
  name: string
  amount?: string
  planned?: boolean
}

type DayStripProps = {
  date: string
  timeZone: string
  events: readonly DayEvent[]
  state?: 'unrecorded' | 'partial' | 'complete'
  sample?: boolean
}

const states = { unrecorded: 'Not recorded', partial: 'Partial', complete: 'Closed' }
const labels = { meal: 'Meal', water: 'Water', workout: 'Workout', activity: 'Activity' }

function Marker({ kind, planned }: Pick<DayEvent, 'kind' | 'planned'>) {
  const fill = planned || kind === 'water' ? 'none' : 'currentColor'
  const line = { fill, stroke: 'currentColor', strokeWidth: 2 }
  return <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
    {kind === 'meal' || kind === 'water' ? <circle cx="8" cy="8" r="5" {...line} /> :
      kind === 'workout' ? <rect x="3" y="3" width="10" height="10" {...line} /> :
        <path d="M8 2.5 14 13H2Z" {...line} />}
  </svg>
}

function useNow(enabled: boolean) {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    if (!enabled) return
    const refresh = () => setNow(Date.now())
    const refreshSoon = window.setTimeout(refresh, 0)
    const interval = window.setInterval(refresh, 60_000)
    return () => {
      window.clearTimeout(refreshSoon)
      window.clearInterval(interval)
    }
  }, [enabled])
  return enabled ? now : null
}

export function DayStrip({ date, timeZone, events, state, sample = false }: DayStripProps) {
  const now = useNow(!sample)
  const [focused, setFocused] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [swept, setSwept] = useState(false)
  const { start, end } = useMemo(() => getDayBounds(date, timeZone), [date, timeZone])
  const duration = end - start
  const time = useMemo(() => new Intl.DateTimeFormat(undefined, {
    timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset',
  }), [timeZone])
  const tickTime = useMemo(() => new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }), [timeZone])
  const allEntries = events.map(event => ({ ...event, instant: Date.parse(event.occurredAt) }))
    .filter(event => Number.isFinite(event.instant))
    .sort((left, right) => left.instant - right.instant)
  const entries = allEntries.filter(event => event.instant >= start && event.instant < end)
  const outside = allEntries.filter(event => event.instant < start || event.instant >= end)
  const percentage = (instant: number) => (instant - start) / duration * 100
  const ticks = Array.from({ length: Math.ceil(duration / hour) }, (_, index) => start + index * hour)
  const description = (event: typeof entries[number]) =>
    [time.format(event.instant), event.planned ? `Planned ${labels[event.kind].toLowerCase()}` : labels[event.kind], event.name, event.amount].filter(Boolean).join(', ')
  const active = entries.find(event => event.id === (focused ?? hovered))
  const showNow = now !== null && now >= start && now < end

  return (
    <section aria-label={sample ? 'Sample day strip' : 'Day strip'} className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-xl font-semibold">{sample ? 'Sample day' : 'Day strip'}</h2>
        {state && <p className="text-sm font-medium text-muted-foreground">{states[state]}</p>}
      </div>
      <div className="relative mx-4 min-w-0">
        <div className="relative h-14 border-b border-border">
          <div className="pointer-events-none absolute inset-x-0 bottom-0"><UnrecordedHatch /></div>
          {ticks.map((instant, index) => <span key={instant} aria-hidden="true"
            className="absolute bottom-0 border-l border-border" style={{ left: `${percentage(instant)}%`, height: index % 6 === 0 ? '12px' : '6px' }} />)}
          {showNow && <span aria-hidden="true" className={`tempo-now-marker pointer-events-none absolute inset-y-0 z-10 ${swept ? '' : 'day-strip-now'}`}
            style={{ left: `${percentage(now)}%` }} onAnimationEnd={() => setSwept(true)} />}
          {entries.map((event, index) => {
            const nearPrior = index > 0 && percentage(event.instant) - percentage(entries[index - 1].instant) < 3
            return <button key={event.id} type="button" aria-label={description(event)}
              className="absolute z-20 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-transparent bg-background text-mark focus-visible:z-30"
              style={{ left: `${percentage(event.instant)}%`, bottom: nearPrior && index % 2 ? 23 : 4 }}
              onClick={pointer => pointer.currentTarget.focus()} onFocus={() => setFocused(event.id)} onBlur={() => setFocused(null)}
              onMouseEnter={() => setHovered(event.id)} onMouseLeave={() => setHovered(null)}>
              <Marker kind={event.kind} planned={event.planned} />
            </button>
          })}
        </div>
        <div className="relative mt-2 h-5 text-xs tabular-nums text-muted-foreground" aria-hidden="true">
          {ticks.filter((_, index) => index % 6 === 0 && index < ticks.length - 1).map(instant => <span key={instant}
            className="absolute -translate-x-1/2" style={{ left: `${percentage(instant)}%` }}>{tickTime.format(instant)}</span>)}
          <span className="absolute right-0 translate-x-1/2">{tickTime.format(end)}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <p className="text-muted-foreground">Not recorded between marks</p>
        {showNow && <p className="text-muted-foreground">Now {time.format(now)}</p>}
        {sample && <p className="text-muted-foreground">Fictional example</p>}
      </div>
      <p aria-hidden="true" className="min-h-6 break-words text-sm font-medium">{active && description(active)}</p>
      {outside.length > 0 && <div className="space-y-1 text-sm">
        <p className="font-medium">Records outside this time zone's day</p>
        <ul className="list-disc pl-5">
          {outside.map(event => <li key={event.id}>{description(event)}</li>)}
        </ul>
      </div>}
      {entries.length > 0 && <ul className="sr-only" aria-label="Day strip events">
        {entries.map(event => <li key={event.id}>{description(event)}</li>)}
      </ul>}
    </section>
  )
}
