import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  availabilityResponseSchema, routinesResponseSchema, scheduleAcceptResponseSchema,
  scheduleProposalResponseSchema, scheduleResponseSchema, workoutSessionResponseSchema,
} from '@fit-tempo/contracts'
import { useNavigate } from 'react-router-dom'
import { GlassPanel } from '@/components/shared/GlassPanel'
import { ValuePicker } from '@/components/shared/ValuePicker'
import { Button } from '@/components/ui/button'
import type { Session } from '@/lib/api/session'
import { mealWallTime, resolveMealInstant } from './meal-form'

const availabilityPath = '/me/availability'
const schedulePath = '/me/scheduled-workouts'
const proposalsPath = '/me/schedule-proposals'
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const label = 'grid min-w-0 gap-1 text-sm font-semibold'
type Availability = ReturnType<typeof availabilityResponseSchema.parse>['data']
type ProposalResponse = ReturnType<typeof scheduleProposalResponseSchema.parse>['data']
type Proposal = NonNullable<ProposalResponse['proposal']>
type Occurrence = ReturnType<typeof scheduleResponseSchema.parse>['data']['workouts'][number]
type AcceptBody = { expectedRevision: number; clientOperationId: string }
type Action =
  | { kind: 'availability'; body: Pick<Availability, 'slots' | 'restDays'> & { expectedRevision: number } }
  | { kind: 'schedule'; body: { routineId: string; startsAt: string; expectedRevision: number } }
  | { kind: 'status'; id: string; body: { status: 'cancelled' | 'skipped'; expectedRevision: number } }
  | { kind: 'start'; body: { routineId: string; expectedRoutineRevision: number; scheduledWorkoutId: string; variantId?: string } }
  | { kind: 'preview'; body: { workoutId: string; expectedRevision: number } }
  | { kind: 'accept'; id: string; body: AcceptBody }

function AvailabilityForm({ availability, busy, submit }: { availability: Availability; busy: boolean; submit: (action: Action) => void }) {
  const [slots, setSlots] = useState(availability.slots)
  const [restDays, setRestDays] = useState(availability.restDays)
  const [error, setError] = useState('')
  function update(index: number, patch: Partial<Availability['slots'][number]>) {
    setSlots(slots.map((slot, position) => position === index ? { ...slot, ...patch } : slot))
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (slots.some(slot => slot.start >= slot.end)) {
      setError('Each window must end after it starts on the same day.')
      return
    }
    setError('')
    submit({ kind: 'availability', body: { slots: slots.map(slot => ({
      ...slot, equipment: [...new Set(slot.equipment.map(item => item.trim()).filter(Boolean))],
    })), restDays, expectedRevision: availability.revision } })
  }
  return <GlassPanel tone="solid"><details>
    <summary className="min-h-11 cursor-pointer py-3 text-xl font-semibold">Weekly availability</summary>
    <form className="space-y-4" onSubmit={save}>
    <p className="text-sm text-muted-foreground">Windows repeat in {availability.timeZone}. Add the equipment available during each window.</p>
    <fieldset disabled={busy} className="space-y-3">
      <legend className="font-semibold">Workout windows</legend>
      {slots.length === 0 && <p className="text-sm">No saved windows.</p>}
      {slots.map((slot, index) => <div key={index} className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2 lg:grid-cols-4">
        <ValuePicker label={`Day for window ${index + 1}`} value={String(slot.weekday)} disabled={busy}
          onValueChange={value => update(index, { weekday: Number(value) })}
          options={days.map((label, weekday) => ({ value: String(weekday), label }))} />
        <label className={label}>Start<input className="tempo-field" required type="time" value={slot.start}
          onChange={event => update(index, { start: event.target.value })} /></label>
        <label className={label}>End<input className="tempo-field" required type="time" value={slot.end}
          onChange={event => update(index, { end: event.target.value })} /></label>
        <label className={label}>Equipment (comma separated)<input className="tempo-field" value={slot.equipment.join(',')}
          maxLength={300} onChange={event => update(index, { equipment: event.target.value.split(',') })} /></label>
        <Button type="button" variant="outline" aria-label={`Remove window ${index + 1}`}
          onClick={() => setSlots(slots.filter((_, position) => position !== index))}>Remove window</Button>
      </div>)}
      <Button type="button" variant="outline" disabled={slots.length >= 35}
        onClick={() => setSlots([...slots, { weekday: 3, start: '18:00', end: '18:20', equipment: [] }])}>Add window</Button>
    </fieldset>
    <fieldset disabled={busy}>
      <legend className="font-semibold">Rest days</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">{days.map((day, index) => <label key={day} className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={restDays.includes(index)} onChange={event => setRestDays(event.target.checked ?
          [...restDays, index] : restDays.filter(value => value !== index))} />{day}
      </label>)}</div>
    </fieldset>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <Button type="submit" disabled={busy}>Save availability</Button>
  </form></details></GlassPanel>
}

function localDay(instant: string, zone: string) {
  return mealWallTime(instant, zone).slice(0, 10)
}

function shiftedDay(date: string, offset: number) {
  const instant = new Date(`${date}T12:00:00.000Z`)
  instant.setUTCDate(instant.getUTCDate() + offset)
  return instant.toISOString().slice(0, 10)
}

function weekday(date: string) {
  return new Date(`${date}T12:00:00.000Z`).getUTCDay()
}

const statusNames: Record<string, string> = {
  planned: 'Planned', missed: 'Missed', cancelled: 'Cancelled', completed: 'Completed', skipped: 'Skipped',
}

function TimeRange({ occurrence, displayZone = occurrence.timeZone }: { occurrence: Occurrence; displayZone?: string }) {
  const start = mealWallTime(occurrence.startsAt, displayZone).replace('T', ' ')
  const end = mealWallTime(occurrence.endsAt, displayZone).replace('T', ' ')
  const minutes = (Date.parse(occurrence.endsAt) - Date.parse(occurrence.startsAt)) / 60_000
  return <span className="tempo-tabular">{start} – {start.slice(0, 10) === end.slice(0, 10) ? end.slice(11) : end} ({displayZone}, {minutes} min)</span>
}

export function ProposalDetails({ proposal, busy, submit, close }: {
  proposal: Proposal; busy: boolean; submit: (action: Action) => void; close: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [proposal.id])
  return <GlassPanel tone="solid"><section aria-label="Proposed change" className="space-y-4">
    <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">Review proposed reschedule</h2>
    <div className="grid gap-4 sm:grid-cols-2">
      {([
        { heading: 'Before', occurrence: proposal.before, exercises: proposal.beforeExercises },
        { heading: 'After', occurrence: proposal.after, exercises: proposal.afterExercises },
      ]).map(({ heading, occurrence, exercises }) => <div key={heading} className="space-y-1 border-t border-border pt-2">
        <h3 className="font-semibold">{heading}</h3>
        <p>{occurrence.name}</p>
        <p className="text-sm text-muted-foreground"><TimeRange occurrence={occurrence} /></p>
        <ul className="list-disc pl-5 text-sm">{exercises.map((exercise, index) => <li key={index}>{exercise}</li>)}</ul>
      </div>)}
    </div>
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy} onClick={() => submit({ kind: 'accept', id: proposal.id,
        body: { expectedRevision: proposal.revision, clientOperationId: crypto.randomUUID() } })}>Confirm reschedule</Button>
      <Button disabled={busy} variant="outline" onClick={close}>Discard preview</Button>
    </div>
  </section></GlassPanel>
}

function PrivateWeek({ session, owner }: { session: Session; owner: string }) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const availabilityKey = ['private', owner, 'availability']
  const scheduleKey = ['private', owner, 'scheduled-workouts']
  const [preview, setPreview] = useState<ProposalResponse | null>(null)
  const [retry, setRetry] = useState<Extract<Action, { kind: 'accept' }> | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [weekOffset, setWeekOffset] = useState(0)
  const [agendaTime, setAgendaTime] = useState(() => Date.now())
  const [routineChoice, setRoutineChoice] = useState('')
  const previewTrigger = useRef<HTMLButtonElement>(null)
  const availability = useQuery({ queryKey: availabilityKey, queryFn: ({ signal }) =>
    session.requestPrivate(availabilityPath, availabilityResponseSchema.parse, signal), retry: false })
  const schedule = useQuery({ queryKey: scheduleKey, queryFn: ({ signal }) =>
    session.requestPrivate(schedulePath, scheduleResponseSchema.parse, signal), retry: false })
  const routines = useQuery({ queryKey: ['private', owner, 'routines'], queryFn: ({ signal }) =>
    session.requestPrivate('/me/routines', routinesResponseSchema.parse, signal), retry: false })

  function refresh() {
    void client.invalidateQueries({ queryKey: availabilityKey })
    void client.invalidateQueries({ queryKey: scheduleKey })
  }
  const action = useMutation({
    mutationFn: async (request: Action) => {
      switch (request.kind) {
        case 'availability': return { availability: await session.mutateMeal('PUT', availabilityPath, request.body, availabilityResponseSchema.parse) }
        case 'schedule': return { schedule: await session.mutateMeal('POST', schedulePath, request.body, scheduleResponseSchema.parse) }
        case 'status': return { schedule: await session.mutateMeal('PATCH', `${schedulePath}/${request.id}`, request.body, scheduleResponseSchema.parse) }
        case 'start': return { started: await session.mutateMeal('POST', '/me/workout-sessions', request.body, workoutSessionResponseSchema.parse) }
        case 'preview': return { preview: await session.mutateMeal('POST', proposalsPath, request.body, scheduleProposalResponseSchema.parse) }
        case 'accept': return { accepted: await session.mutateMeal('POST', `${proposalsPath}/${request.id}/accept`, request.body, scheduleAcceptResponseSchema.parse) }
      }
    },
    retry: false,
    onSuccess: (result, request) => {
      setRetry(null)
      if (result.started) {
        void client.invalidateQueries({ queryKey: ['private', owner, 'workout-sessions'] })
        void navigate('/app/workouts')
        return
      }
      if (result.preview) {
        setPreview(result.preview.data)
        return
      }
      setPreview(null)
      if (result.availability) client.setQueryData(availabilityKey, result.availability)
      if (result.schedule) client.setQueryData(scheduleKey, result.schedule)
      setMessage(request.kind === 'accept' ? 'Workout rescheduled.' : request.kind === 'availability' ? 'Availability saved.' : 'Schedule saved.')
      refresh()
    },
    onError: (failure, request) => {
      const status = typeof failure === 'object' && failure && 'status' in failure ? failure.status : undefined
      if (request.kind === 'accept' && (typeof status !== 'number' || status >= 500)) {
        setRetry(request)
        setError('The reschedule result is uncertain. Retry the same confirmation to recover its result.')
        return
      }
      setRetry(null)
      if (status === 409) {
        setPreview(null)
        setError('The schedule changed. Review the refreshed schedule and make a new preview.')
        refresh()
        return
      }
      setError(failure instanceof Error ? failure.message : 'Unable to update the schedule.')
    },
  })
  function submit(request: Action) {
    setError('')
    setMessage('')
    if (request.kind === 'preview') setPreview(null)
    action.mutate(request)
  }
  const ready = schedule.data?.data
  const availabilityData = availability.data?.data
  const busy = action.isPending || retry !== null
  const zone = ready?.timeZone ?? availabilityData?.timeZone
  useEffect(() => {
    const timer = window.setInterval(() => setAgendaTime(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const today = zone ? localDay(new Date(agendaTime).toISOString(), zone) : ''
  const weekStart = today ? shiftedDay(today, -((weekday(today) + 6) % 7) + 7 * weekOffset) : ''
  const week = weekStart ? Array.from({ length: 7 }, (_, index) => shiftedDay(weekStart, index)) : []
  const workouts = ready?.workouts ?? []
  const revisionByRoutine = new Map(routines.data?.data.map(routine => [routine.id, routine.revision]))

  function scheduleWorkout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready) return
    const values = new FormData(event.currentTarget)
    const startsAt = resolveMealInstant(String(values.get('start')), ready.timeZone)
    if (!startsAt) {
      setError('Pick a date and time that occurs once in your schedule time zone.')
      return
    }
    submit({ kind: 'schedule', body: { routineId: String(values.get('routine')), startsAt, expectedRevision: ready.revision } })
  }

  const nextEvent = workouts.filter(workout => workout.status === 'planned' && Date.parse(workout.startsAt) >= agendaTime &&
    ready && week.includes(localDay(workout.startsAt, ready.timeZone)))
    .sort((first, second) => Date.parse(first.startsAt) - Date.parse(second.startsAt))[0]
  return <div className="tempo-card-grid min-w-0">
    <header><h1 className="text-3xl font-semibold">Fit My Week</h1>
      <p className="text-muted-foreground">Plan workouts around your availability and review changes before moving a missed session.</p>
    </header>
    {message && <p role="status" className="text-success">{message}</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {retry && <Button disabled={action.isPending} onClick={() => submit(retry)}>Retry confirmation</Button>}
    {(schedule.isError || availability.isError || routines.isError) && <div role="alert">
      <p>Some schedule information is unavailable.</p>
      <Button variant="outline" onClick={() => { refresh(); void routines.refetch() }}>Retry loading</Button>
    </div>}
    {(schedule.isPending || availability.isPending) && <p role="status">Loading your week.</p>}
    {preview?.proposal && <ProposalDetails proposal={preview.proposal} busy={busy} submit={submit} close={() => {
      setPreview(null)
      previewTrigger.current?.focus()
    }} />}
    {preview && !preview.proposal && <p role="status" className="border-l-2 border-warning pl-3">{preview.reason ?? 'No suitable slot was found.'}</p>}
    {ready && <GlassPanel tone="solid"><section className="space-y-3" aria-label="Workout calendar">
      {nextEvent && <div className="border-b border-border pb-3">
        <p className="text-sm font-medium">Next event this week</p>
        <p className="break-words font-semibold">{nextEvent.name}</p>
        <p className="text-sm">{localDay(nextEvent.startsAt, ready.timeZone)} · <TimeRange occurrence={nextEvent} displayZone={ready.timeZone} /></p>
      </div>}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-xl font-semibold">Week of {weekStart}</h2>
        <Button variant="outline" onClick={() => setWeekOffset(weekOffset - 1)}>Previous week</Button>
        <Button variant="outline" onClick={() => setWeekOffset(0)}>This week</Button>
        <Button variant="outline" onClick={() => setWeekOffset(weekOffset + 1)}>Next week</Button>
      </div>
      <p className="text-sm text-muted-foreground">{zone}</p>
      <ol className="space-y-3">
        {week.map(date => {
          const dayWorkouts = workouts.filter(workout => localDay(workout.startsAt, ready.timeZone) === date)
          const restDay = availabilityData?.restDays.includes(weekday(date))
          return <li key={date} className="border-t border-border pt-2">
            <h3 className="font-semibold">{days[weekday(date)]} <span className="text-sm font-normal text-muted-foreground">{date}{date === today && ' · Today'}{restDay ? ' · Rest day' : ''}</span></h3>
            {dayWorkouts.length === 0 && !restDay && <p className="text-sm text-muted-foreground">No workouts planned.</p>}
            <ul className="space-y-2">{dayWorkouts.map(workout => <li key={workout.id} className="min-w-0">
              <details><summary className="min-h-11 cursor-pointer break-words py-3"><span className="font-medium">{workout.name} · {statusNames[workout.status] ?? workout.status}</span>
                <span className="block text-sm text-muted-foreground"><TimeRange occurrence={workout} displayZone={ready.timeZone} /></span></summary>
              <div className="flex flex-wrap items-center gap-2 pb-2">
              {workout.status === 'planned' && revisionByRoutine.has(workout.routineId) && <Button disabled={busy}
                onClick={() => submit({ kind: 'start', body: { routineId: workout.routineId,
                  expectedRoutineRevision: revisionByRoutine.get(workout.routineId)!, scheduledWorkoutId: workout.id,
                  ...(workout.variantId ? { variantId: workout.variantId } : {}),
                } })}>Start workout</Button>}
              {workout.status === 'missed' && <Button disabled={busy} onClick={event => {
                previewTrigger.current = event.currentTarget
                submit({ kind: 'preview', body: { workoutId: workout.id, expectedRevision: ready.revision } })
              }}>Find a new slot</Button>}
              {(workout.status === 'planned' || workout.status === 'missed') &&
                <Button disabled={busy} variant="outline" onClick={() => submit({
                  kind: 'status', id: workout.id,
                  body: { status: workout.status === 'missed' ? 'skipped' : 'cancelled', expectedRevision: ready.revision },
                })}>{workout.status === 'missed' ? 'Skip workout' : 'Cancel workout'}</Button>}
              </div></details>
            </li>)}</ul>
          </li>
        })}
      </ol>
    </section></GlassPanel>}
    {ready && <GlassPanel tone="solid"><details><summary className="min-h-11 cursor-pointer py-3 text-xl font-semibold">Schedule a workout</summary><form className="space-y-3" onSubmit={scheduleWorkout}>
      <fieldset disabled={busy || !routines.data?.data.length} className="grid gap-3 sm:grid-cols-2">
        <ValuePicker label="Routine" name="routine" required searchable disabled={busy || !routines.data?.data.length}
          loading={routines.isPending} placeholder="Choose a routine" value={routineChoice} onValueChange={setRoutineChoice}
          options={(routines.data?.data ?? []).map(routine => ({ value: routine.id, label: `${routine.name} (${routine.durationMinutes} min)` }))} />
        <label className={label}>Start ({ready.timeZone})<input required type="datetime-local" name="start" className="tempo-field" /></label>
        <Button type="submit" disabled={!routineChoice}>Add to schedule</Button>
      </fieldset>
      {routines.data?.data.length === 0 && <p className="text-sm">Create a routine on the Exercises page to schedule it.</p>}
    </form></details></GlassPanel>}
    {availabilityData && <AvailabilityForm key={availabilityData.revision} availability={availabilityData} busy={busy} submit={submit} />}
  </div>
}

export function FitMyWeekPage({ session }: { session: Session }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  if (snapshot.status !== 'authenticated') return null
  return <PrivateWeek key={snapshot.user.id} session={session} owner={snapshot.user.id} />
}
