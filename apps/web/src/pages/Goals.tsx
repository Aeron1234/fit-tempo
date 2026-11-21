import { useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { hydrationGoalResponseSchema, hydrationGoalsResponseSchema, positiveDecimalSchema, waterEntryResponseSchema, waterResponseSchema } from '@fit-tempo/contracts'
import { Button } from '@/components/ui/button'
import { GlassPanel } from '@/components/shared/GlassPanel'
import type { Session } from '@/lib/api/session'
import { canonicalMealDecimal, mealWallTime, resolveMealInstant } from './meal-form'

type Action =
  | { kind: 'water'; path: string; method: 'POST' | 'PATCH'; body: { amountMl: string; occurredAt: string; clientOperationId?: string } }
  | { kind: 'goal'; path: string; method: 'POST' | 'PATCH'; body: { targetMl: string } | { status: 'retired' } }

function PersonalGoals({ session, owner }: { session: Session; owner: string }) {
  const client = useQueryClient()
  const [date, setDate] = useState('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [retry, setRetry] = useState<Action | null>(null)
  const inFlight = useRef(false)
  const waterKey = ['private', owner, 'water']
  const goalsKey = ['private', owner, 'goals']
  const water = useQuery({ queryKey: [...waterKey, date], queryFn: ({ signal }) =>
    session.requestPrivate('/me/water' + (date ? '?date=' + encodeURIComponent(date) : ''), waterResponseSchema.parse, signal) })
  const goals = useQuery({ queryKey: goalsKey, queryFn: ({ signal }) =>
    session.requestPrivate('/me/goals', hydrationGoalsResponseSchema.parse, signal) })
  const write = useMutation({
    mutationFn: async (action: Action) => {
      if (action.kind === 'water') await session.mutateMeal(action.method, action.path, action.body, waterEntryResponseSchema.parse)
      else await session.mutateMeal(action.method, action.path, action.body, hydrationGoalResponseSchema.parse)
    },
    onSuccess: async () => {
      setRetry(null)
      setEditing(null)
      await Promise.all([client.invalidateQueries({ queryKey: waterKey }), client.invalidateQueries({ queryKey: goalsKey })])
    },
    onError: (failure, action) => {
      const status = failure && typeof failure === 'object' && 'status' in failure ? failure.status : undefined
      if (action.kind === 'water' && action.method === 'POST' && (typeof status !== 'number' || status >= 500)) setRetry(action)
      else setRetry(null)
      setError(failure instanceof Error ? failure.message : 'Could not save. Try again.')
    },
    onSettled: () => { inFlight.current = false },
  })
  function submit(action: Action) {
    if (inFlight.current) return
    inFlight.current = true
    setError('')
    write.mutate(action)
  }

  const day = water.data?.data
  const summary = goals.data?.data
  const activeGoal = summary?.goals.find(goal => goal.status === 'active')
  const dayGoal = day && summary?.goals.find(goal => goal.effectiveFrom <= day.date &&
    (goal.effectiveUntil === null ? goal.status === 'active' : goal.effectiveUntil >= day.date))
  const current = day?.entries.find(entry => entry.id === editing)
  const busy = write.isPending || retry !== null
  const field = 'tempo-field px-3 py-2'
  function saveWater(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!day || busy) return
    const form = new FormData(event.currentTarget)
    const amount = positiveDecimalSchema.safeParse(canonicalMealDecimal(String(form.get('amount'))))
    const instant = resolveMealInstant(String(form.get('time')), current?.timeZone ?? day.timeZone)
    if (!amount.success || !instant) { setError('Enter a positive amount in mL and a valid local date and time.'); return }
    submit(current ? { kind: 'water', path: '/me/water/' + current.id, method: 'PATCH', body: { amountMl: amount.data, occurredAt: instant } } :
      { kind: 'water', path: '/me/water', method: 'POST', body: { amountMl: amount.data, occurredAt: instant, clientOperationId: crypto.randomUUID() } })
  }
  return <div className="tempo-card-grid min-w-0">
    <h1 className="text-3xl font-semibold">Hydration and goals</h1>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {retry && <Button onClick={() => submit(retry)} disabled={write.isPending}>Retry the same water entry</Button>}
    {(water.isError || goals.isError) && <p role="alert">Tracking data could not be loaded. <Button variant="outline" onClick={() => { void water.refetch(); void goals.refetch() }}>Retry</Button></p>}
    {(water.isPending || goals.isPending) && <p role="status">Loading hydration and goals.</p>}
    {day && <>
      <label className="flex flex-wrap items-center gap-2">Date <input type="date" className={field} value={date || day.date} onChange={event => { setEditing(null); setDate(event.target.value) }} /></label>

      <GlassPanel tone="solid"><form key={current?.id ?? day.date} className="space-y-3" onSubmit={saveWater}>
        <h2 className="font-semibold">{current ? 'Edit water entry' : 'Log water'}</h2>
        <label className="grid gap-1">Amount (mL)<input required className={field} inputMode="decimal" name="amount" defaultValue={current?.amountMl} /></label>
        <label className="grid gap-1">Date and time ({current?.timeZone ?? day.timeZone})<input required className={field} name="time" type="datetime-local" defaultValue={current ?
          mealWallTime(current.occurredAt, current.timeZone) : day.date + 'T' + mealWallTime(new Date().toISOString(), day.timeZone).slice(11, 16)} /></label>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy}>Save water</Button>
          {current && <Button variant="outline" type="button" onClick={() => setEditing(null)}>Cancel edit</Button>}</div>
      </form></GlassPanel>
      <GlassPanel title="Water recorded"><p>{day.totalMl === null ? 'Not recorded' : day.totalMl + ' mL'} · {day.timeZone}</p>
        <ul className="divide-y divide-border">{day.entries.map(entry => <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span>{entry.amountMl} mL · {mealWallTime(entry.occurredAt, entry.timeZone).replace('T', ' ')} ({entry.timeZone})</span>
          <Button variant="outline" disabled={busy} onClick={() => setEditing(entry.id)}>Edit</Button>
        </li>)}</ul>
      </GlassPanel>
    </>}
    {summary && <>
      <GlassPanel title="Goal progress">
        {activeGoal ? <p>Current daily target: {activeGoal.targetMl} mL, effective {activeGoal.effectiveFrom}.</p> : <p>No active hydration goal.</p>}
        {day && dayGoal && <p>{day.date}: {day.totalMl === null ? 'Not recorded' : day.totalMl + ' mL recorded'} · target {dayGoal.targetMl} mL.</p>}
        <p>Completed workout streak: {summary.workoutStreak}. Rest days do not break it.</p>
        <details className="border-t border-border"><summary className="min-h-11 cursor-pointer py-3 font-semibold">Milestones</summary>
        {summary.milestones.length === 0 ? <p>No milestones recorded.</p> : <ul>{summary.milestones.map(item => <li key={item.id}>
          Hydration target crossed · {day ? mealWallTime(item.occurredAt, day.timeZone).replace('T', ' ') + ' (' + day.timeZone + ')' : item.occurredAt}
        </li>)}</ul>}</details>
      </GlassPanel>
      <GlassPanel tone="solid"><details><summary className="min-h-11 cursor-pointer py-3 font-semibold">Manage personal hydration goal</summary><form className="space-y-3" onSubmit={event => {
        event.preventDefault()
        if (busy || activeGoal) return
        const target = positiveDecimalSchema.safeParse(canonicalMealDecimal(String(new FormData(event.currentTarget).get('target'))))
        if (!target.success) { setError('Enter a positive target in mL.'); return }
        submit({ kind: 'goal', path: '/me/goals', method: 'POST', body: { targetMl: target.data } })
      }}>
        <h2 className="font-semibold">Personal hydration goal</h2>
        {activeGoal ? <Button type="button" variant="outline" disabled={busy} onClick={() =>
          submit({ kind: 'goal', path: '/me/goals/' + activeGoal.id, method: 'PATCH', body: { status: 'retired' } })}>End goal cycle</Button> :
          <><label className="grid gap-1">Daily target (mL)<input required className={field} name="target" inputMode="decimal" /></label>
          <Button type="submit" disabled={busy}>Start goal cycle</Button></>}
      </form></details></GlassPanel>
    </>}
  </div>
}

export function GoalsPage({ session }: { session: Session }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  return snapshot.status === 'authenticated' ? <PersonalGoals key={snapshot.user.id} owner={snapshot.user.id} session={session} /> : null
}
