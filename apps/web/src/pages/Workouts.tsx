import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  routinesResponseSchema, workoutSessionsResponseSchema, workoutSessionResponseSchema,
  workoutSetSnapshotSchema, workoutCompleteSchema, workoutPatchSchema, workoutStartSchema,
  type WorkoutSession,
} from '@fit-tempo/contracts'
import { GlassPanel } from '@/components/shared/GlassPanel'
import { Button } from '@/components/ui/button'
import type { Session } from '@/lib/api/session'

type Measurement = WorkoutSession['snapshot']['exercises'][number]['targets'][number]['measurement']
type Action = { method: 'POST' | 'PATCH'; path: string; body: object }
const path = '/me/workout-sessions'
const label = 'grid gap-1 text-sm font-medium'
const field = 'tempo-field w-full'

function measurementLabel(value: Measurement) {
  switch (value.type) {
    case 'external_load': return `${value.reps} reps · ${value.loadKg} kg`
    case 'bodyweight': return `${value.reps} reps`
    case 'timed': return `${value.durationSeconds} seconds`
    case 'distance': return `${value.distanceMeters} meters${value.durationSeconds === null ? '' : ` · ${value.durationSeconds} seconds`}`
  }
}

const decimal = (value: string) => value.trim().replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

function SetForm({ order, target, actual, busy, save, cancel }: {
  order: number; target: Measurement; actual?: Measurement; busy: boolean
  save: (set: ReturnType<typeof workoutSetSnapshotSchema.parse>) => void; cancel: () => void
}) {
  const [issue, setIssue] = useState('')
  const initial = actual ?? target
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input = new FormData(event.currentTarget)
    const read = (key: string) => decimal(String(input.get(key) ?? ''))
    const measurement = target.type === 'external_load'
      ? { type: target.type, reps: Number(read('reps')), loadKg: read('kg') }
      : target.type === 'bodyweight' ? { type: target.type, reps: Number(read('reps')) }
      : target.type === 'timed' ? { type: target.type, durationSeconds: read('seconds') }
      : { type: target.type, distanceMeters: read('meters'), durationSeconds: read('seconds') || null }
    const result = workoutSetSnapshotSchema.safeParse({ setOrder: order, measurement })
    if (!result.success) {
      setIssue('Enter valid reps, load, duration or distance for this exercise.')
      return
    }
    setIssue('')
    save(result.data)
  }
  return <form className="mt-2 space-y-3 border-l border-border pl-3" onSubmit={submit}>
    <fieldset disabled={busy} className="grid gap-2 sm:grid-cols-2">
      <legend className="font-medium">Actual set {order}</legend>
      {'reps' in initial && <label className={label}>Reps<input name="reps" className={field} type="number" min="1" max="10000" defaultValue={actual && "reps" in actual ? actual.reps : ""} required /></label>}
      {'loadKg' in initial && <label className={label}>Load (kg)<input name="kg" className={field} inputMode="decimal" defaultValue={actual && "loadKg" in actual ? actual.loadKg : ""} required /></label>}
      {'distanceMeters' in initial && <label className={label}>Distance (meters)<input name="meters" className={field} inputMode="decimal" defaultValue={actual && "distanceMeters" in actual ? actual.distanceMeters : ""} required /></label>}
      {'durationSeconds' in initial && <label className={label}>Duration (seconds){initial.type === 'distance' ? ' (optional)' : ''}<input name="seconds" className={field} inputMode="decimal" defaultValue={actual && 'durationSeconds' in actual ? actual.durationSeconds ?? '' : ''} required={initial.type === 'timed'} /></label>}
    </fieldset>
    {issue && <p role="alert" className="text-sm text-destructive">{issue}</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={busy}>Save set</Button>
      <Button type="button" variant="outline" onClick={cancel} disabled={busy}>Cancel</Button></div>
  </form>
}

function WorkoutCard({ workout, busy, submit, boxed = true }: {
  workout: WorkoutSession; busy: boolean; submit: (action: Action) => void; boxed?: boolean
}) {
  const [now, setNow] = useState(Date.now)
  const [editor, setEditor] = useState<{ index: number; order: number; revision: number } | null>(null)
  const [confirmRevision, setConfirmRevision] = useState<number | null>(null)
  const [restSeconds, setRestSeconds] = useState('60')
  const [restIssue, setRestIssue] = useState('')
  const editable = workout.status === 'inProgress' || workout.status === 'paused'
  const paused = workout.status === 'paused'
  useEffect(() => {
    if (!workout.activeSince && !workout.restEndsAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [workout.activeSince, workout.restEndsAt])
  const elapsed = workout.elapsedSeconds + (workout.activeSince ? Math.max(0, Math.floor((now - Date.parse(workout.activeSince)) / 1000)) : 0)
  const rest = workout.restEndsAt ? Math.max(0, Math.ceil((Date.parse(workout.restEndsAt) - now) / 1000)) : workout.restRemainingSeconds
  const activeEditor = editor?.revision === workout.revision ? editor : null
  const base = `${path}/${workout.id}`
  function patch(command: object) {
    const body = workoutPatchSchema.parse({ ...command, expectedRevision: workout.revision })
    submit({ method: 'PATCH', path: base, body })
  }
  const nextExercise = workout.snapshot.exercises.findIndex(exercise =>
    exercise.targets.some(target => !exercise.actualSets.some(set => set.setOrder === target.setOrder)))
  const primaryExercise = activeEditor?.index ?? Math.max(0, nextExercise)
  const content = <div className="space-y-4">
    <div>
      <h3 className="text-lg font-semibold">{workout.snapshot.name}</h3>
      <p className="text-sm text-muted-foreground">{paused ? 'Paused' : workout.status === 'inProgress' ? 'In progress' : workout.status === 'completed' ? 'Completed' : 'Abandoned'}</p>
      <p className="text-sm"><span className="font-medium">Active time </span><time>{clock(elapsed)}</time></p>
    </div>
    {editable && <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => patch({ action: paused ? 'resume' : 'pause' })}>{paused ? 'Resume workout' : 'Pause workout'}</Button>
        <Button variant="outline" disabled={busy} onClick={() => setConfirmRevision(workout.revision)}>Finish workout</Button>
      </div>
      <details className="border-t border-border">
      <summary className="min-h-11 cursor-pointer py-3 font-medium">Rest remaining <time>{clock(rest ?? 0)}</time></summary>
      <form className="space-y-2" onSubmit={event => {
        event.preventDefault()
        const validated = workoutPatchSchema.safeParse({ action: 'startRest', seconds: Number(restSeconds), expectedRevision: workout.revision })
        if (!validated.success) {
          setRestIssue('Enter a valid number of rest seconds.')
          return
        }
        setRestIssue('')
        submit({ method: 'PATCH', path: base, body: validated.data })
      }}>
        <label className={label}>Rest seconds<input className={field} type="number" min="1" required value={restSeconds} disabled={busy || paused} onChange={event => setRestSeconds(event.target.value)} /></label>
        {restIssue && <p role="alert" className="text-sm text-destructive">{restIssue}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="outline" disabled={busy || paused}>Start rest</Button>
          <Button type="button" variant="outline" disabled={busy || !rest} onClick={() => patch({ action: 'clearRest' })}>Clear rest</Button>
        </div>
      </form></details>
      {confirmRevision === workout.revision && <div className="space-y-2 border-t border-border pt-3">
        <p className="font-medium">Complete this workout with its saved sets?</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => submit({ method: 'POST', path: `${base}/complete`,
            body: workoutCompleteSchema.parse({ expectedRevision: workout.revision, clientOperationId: crypto.randomUUID() }) })}>Confirm completion</Button>
          <Button disabled={busy} variant="outline" onClick={() => setConfirmRevision(null)}>Keep tracking</Button>
        </div>
      </div>}
    </div>}
    <ol className="space-y-3">
      {workout.snapshot.exercises.map((exercise, index) => {
        const target = exercise.targets[0]!.measurement
        const occupied = new Set([...exercise.targets, ...exercise.actualSets].map(set => set.setOrder))
        const nextOrder = Array.from({ length: 100 }, (_, offset) => offset + 1).find(order => !occupied.has(order))
        const extraSets = exercise.actualSets.filter(set => !exercise.targets.some(item => item.setOrder === set.setOrder))
        return <li key={`${exercise.exerciseId}-${index}`} className="border-t border-border pt-2">
        <details open={editable && index === primaryExercise}>
        <summary className="min-h-11 cursor-pointer py-3 font-semibold">
          {exercise.name} <span className="font-normal text-muted-foreground">({exercise.actualSets.length} sets recorded)</span>
        </summary>
        <ul className="space-y-2 text-sm">
          {exercise.targets.map(target => {
            const actual = exercise.actualSets.find(set => set.setOrder === target.setOrder)?.measurement
            const primary = index === primaryExercise && exercise.targets.find(item => !exercise.actualSets.some(set => set.setOrder === item.setOrder))?.setOrder === target.setOrder
            return <li key={target.setOrder}>
              <p>Set {target.setOrder} · Target {measurementLabel(target.measurement)}</p>
              <p className="text-muted-foreground">{actual ? `Recorded ${measurementLabel(actual)}` : 'No actual set recorded'}</p>
              {editable && <div className="mt-1 flex flex-wrap gap-2">
                <Button variant={primary && !actual ? "default" : "outline"} disabled={busy} onClick={() => setEditor({ index, order: target.setOrder, revision: workout.revision })}>{actual ? 'Edit set' : 'Record set'}</Button>
                {actual && <Button variant="outline" disabled={busy} onClick={() => patch({ action: 'removeSet', exerciseIndex: index, setOrder: target.setOrder })}>Remove set</Button>}
              </div>}
              {editable && activeEditor?.index === index && activeEditor.order === target.setOrder &&
                <SetForm key={workout.revision} order={target.setOrder} target={target.measurement} actual={actual} busy={busy}
                  cancel={() => setEditor(null)} save={set => patch({ action: 'saveSet', exerciseIndex: index, set })} />}
            </li>
          })}
          {extraSets.map(set => <li key={set.setOrder}>
            <p>Extra set {set.setOrder} ? Recorded {measurementLabel(set.measurement)}</p>
            {editable && <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setEditor({ index, order: set.setOrder, revision: workout.revision })}>Edit set</Button>
              <Button variant="outline" disabled={busy} onClick={() => patch({ action: 'removeSet', exerciseIndex: index, setOrder: set.setOrder })}>Remove set</Button>
            </div>}
          </li>)}
        </ul>
        {editable && nextOrder !== undefined && <Button variant="outline" className="mt-2" disabled={busy}
          onClick={() => setEditor({ index, order: nextOrder, revision: workout.revision })}>Record extra set</Button>}
        {editable && activeEditor?.index === index &&
          !exercise.targets.some(item => item.setOrder === activeEditor.order) &&
          <SetForm key={`${activeEditor.order}-${workout.revision}`} order={activeEditor.order} target={target}
            actual={extraSets.find(set => set.setOrder === activeEditor.order)?.measurement}
            busy={busy} cancel={() => setEditor(null)} save={set => patch({ action: 'saveSet', exerciseIndex: index, set })} />}
        </details>
      </li>
      })}
    </ol>
    {workout.volume.length > 0 && <div>
      <h4 className="font-semibold">External-load volume by exercise</h4>
      <ul className="tempo-ledger text-sm">{workout.volume.map(item => <li key={item.exerciseId}>{item.name} · {item.kgReps} kg × reps</li>)}</ul>
    </div>}
  </div>
  return boxed ? <GlassPanel tone="solid">{content}</GlassPanel> : <article className="border-t border-border py-4">{content}</article>
}

function PrivateWorkouts({ session, owner }: { session: Session; owner: string }) {
  const client = useQueryClient()
  const [failure, setFailure] = useState('')
  const [retry, setRetry] = useState<Action | null>(null)
  const workoutKey = ['private', owner, 'workout-sessions']
  const workouts = useQuery({
    queryKey: workoutKey, retry: false,
    queryFn: ({ signal }) => session.requestPrivate(path, workoutSessionsResponseSchema.parse, signal),
  })
  const routines = useQuery({
    queryKey: ['private', owner, 'routines'], retry: false,
    queryFn: ({ signal }) => session.requestPrivate('/me/routines', routinesResponseSchema.parse, signal),
  })
  const write = useMutation({
    retry: false,
    mutationFn: (action: Action) => session.mutateMeal(action.method, action.path, action.body, workoutSessionResponseSchema.parse),
    onSuccess: ({ data }) => {
      client.setQueryData(workoutKey, (prior: { data: WorkoutSession[] } | undefined) => ({
        data: [data, ...(prior?.data.filter(row => row.id !== data.id) ?? [])],
      }))
      setRetry(null)
      setFailure('')
      void client.invalidateQueries({ queryKey: workoutKey })
    },
    onError: (error, action) => {
      const status = typeof error === 'object' && error && 'status' in error ? error.status : undefined
      if (action.path.endsWith('/complete') && (typeof status !== 'number' || status >= 500)) {
        setRetry(action)
        setFailure('The completion result is uncertain. Retry the same request to recover the saved result.')
        return
      }
      setRetry(null)
      setFailure(status === 409 ? 'This workout or routine changed. Review the latest saved data and try again.'
        : error instanceof Error ? error.message : 'Unable to save the workout.')
      if (status === 409) {
        void workouts.refetch()
        void routines.refetch()
      }
    },
  })
  function submit(action: Action) {
    setFailure('')
    write.mutate(action)
  }
  const saved = workouts.data?.data ?? []
  const open = saved.filter(item => item.status === 'inProgress' || item.status === 'paused')
  const history = saved.filter(item => item.status === 'completed' || item.status === 'abandoned')
  const busy = write.isPending || retry !== null
  return <div className="tempo-card-grid min-w-0">
    <header><h1 className="text-3xl font-semibold">Workout sessions</h1>
      <p className="text-muted-foreground">Track actual sets and rest. Saved progress returns when you reload.</p></header>
    {failure && <p role="alert" className="text-destructive">{failure}</p>}
    {retry && <Button disabled={write.isPending} onClick={() => submit(retry)}>Retry completion</Button>}
    {open.length > 0 && <section className="space-y-3"><h2 className="text-xl font-semibold">Active workouts</h2>
      {open.map(workout => <WorkoutCard key={workout.id} workout={workout} busy={busy} submit={submit} />)}</section>}
    <GlassPanel tone="solid"><details open={open.length === 0}>
      <summary className="min-h-11 cursor-pointer py-3 text-xl font-semibold">Start from a routine</summary>
      {routines.isPending && <LoadingSkeleton label="Loading workout routines." shape="rows" />}
      {routines.isError && <p role="alert">Routines are unavailable. <Button variant="outline" onClick={() => void routines.refetch()}>Retry loading</Button></p>}
      {routines.data?.data.length === 0 && <p>Create a routine on the Exercises page to start a workout.</p>}
      {routines.data?.data.map(routine => <div key={routine.id} className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
        <span className="font-medium">{routine.name}</span>
        <Button disabled={busy || !workouts.data} onClick={() => submit({ method: 'POST', path,
          body: workoutStartSchema.parse({ routineId: routine.id, expectedRoutineRevision: routine.revision }) })}>Start workout</Button>
        {routine.shorterVariants.map(variant => <Button key={variant.id} variant="outline" disabled={busy || !workouts.data}
          onClick={() => submit({ method: 'POST', path, body: workoutStartSchema.parse({ routineId: routine.id,
            expectedRoutineRevision: routine.revision, variantId: variant.id }) })}>Start {variant.name}</Button>)}
      </div>)}
    </details></GlassPanel>
    <GlassPanel tone="solid" title="Workout history">
      {workouts.isPending && <LoadingSkeleton label="Loading workout sessions." shape="rows" />}
      {workouts.isError && <p role="alert">Workout sessions are unavailable. <Button variant="outline" onClick={() => void workouts.refetch()}>Retry loading</Button></p>}
      {workouts.data && history.length === 0 && <p>No completed workouts yet.</p>}
      {history.map(workout => <WorkoutCard key={workout.id} workout={workout} busy={busy} submit={submit} boxed={false} />)}
    </GlassPanel>
  </div>
}

export function WorkoutsPage({ session }: { session: Session }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  if (snapshot.status !== 'authenticated') return null
  return <PrivateWorkouts key={snapshot.user.id} session={session} owner={snapshot.user.id} />
}
