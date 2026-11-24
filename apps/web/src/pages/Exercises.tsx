import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { ValuePicker } from '@/components/shared/ValuePicker'
import { GlassPanel } from '@/components/shared/GlassPanel'
import { useState, useSyncExternalStore, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  exerciseWriteSchema, exerciseEditSchema, exerciseMutationResponseSchema, exercisesResponseSchema,
  routineWriteSchema, routineEditSchema, routineArchiveSchema, routinesResponseSchema,
} from '@fit-tempo/contracts'
import { Button } from '@/components/ui/button'
import type { Session } from '@/lib/api/session'

type Exercise = ReturnType<typeof exercisesResponseSchema.parse>['data'][number]
type Routine = ReturnType<typeof routinesResponseSchema.parse>['data'][number]
type Measurement = Exercise['measurementType']
type Action = { path: string; method: 'POST' | 'PATCH' | 'DELETE'; body: object }
type Draft = { key: number; exerciseId: string; sets: string; reps: string; load: string; seconds: string; meters: string; rest: string }
const types: Record<Measurement, string> = {
  externalLoad: 'External load (kg and reps)',
  bodyweight: 'Bodyweight (reps)',
  timed: 'Timed (seconds)',
  distance: 'Distance (meters)',
}
const label = 'grid min-w-0 gap-1 text-sm font-medium'
const field = 'tempo-field w-full min-w-0'
const value = (data: FormData, key: string) => String(data.get(key) ?? '').trim()
const decimal = (text: string) => text.trim().replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')
const optionalInt = (text: string) => text.trim() ? Number(text.trim()) : null

function ExerciseForm({ exercise, measurementLocked, busy, submit, cancel }: {
  exercise?: Exercise; measurementLocked: boolean; busy: boolean; submit: (action: Action) => void; cancel: () => void
}) {
  const [measurement, setMeasurement] = useState<string>(exercise?.measurementType ?? 'bodyweight')
  const [issue, setIssue] = useState('')
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const draft = {
      name: value(data, 'name'), equipment: value(data, 'equipment') || null,
      instructions: value(data, 'instructions') || null,
      measurementType: measurementLocked ? exercise?.measurementType : value(data, 'measurementType'),
      ...(exercise ? { expectedRevision: exercise.revision } : {}),
    }
    const validated = (exercise ? exerciseEditSchema : exerciseWriteSchema).safeParse(draft)
    if (!validated.success) {
      setIssue(validated.error.issues[0]?.message ?? 'Check the exercise details.')
      return
    }
    setIssue('')
    submit({ path: exercise ? `/me/exercises/${exercise.id}` : '/me/exercises', method: exercise ? 'PATCH' : 'POST', body: validated.data })
  }
  return <form className="space-y-3 border-b border-border pb-4" onSubmit={save}>
    <h3 className="text-lg font-semibold">{exercise ? 'Edit exercise' : 'Add an exercise'}</h3>
    <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
      <label className={label}>Name<input name="name" className={field} required maxLength={200} defaultValue={exercise?.name} /></label>
      <ValuePicker label="Measurement" name="measurementType" value={measurement} onValueChange={setMeasurement}
        disabled={busy || measurementLocked} options={Object.entries(types).map(([value, label]) => ({ value, label }))}
        description={measurementLocked ? 'This exercise has saved routine targets.' : undefined} />
      <label className={label}>Equipment (optional)<input name="equipment" className={field} maxLength={120} defaultValue={exercise?.equipment ?? ''} /></label>
      <label className={label}>Instructions (optional)<textarea name="instructions" className={field} maxLength={4000} defaultValue={exercise?.instructions ?? ''} /></label>
    </fieldset>
    {issue && <p role="alert" className="text-sm text-destructive">{issue}</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={busy}>Save exercise</Button>
      <Button variant="outline" type="button" onClick={cancel}>Cancel</Button></div>
  </form>
}

function RoutineForm({ routine, catalog, busy, submit, cancel }: {
  routine?: Routine; catalog: Exercise[]; busy: boolean; submit: (action: Action) => void; cancel: () => void
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => routine?.exercises.map((item, key) => ({
    key, exerciseId: item.exerciseId, sets: String(item.targetSets ?? ''), reps: String(item.targetReps ?? ''),
    load: item.targetLoadKg ?? '', seconds: item.targetSeconds ?? '', meters: item.targetMeters ?? '',
    rest: String(item.restSeconds ?? ''),
  })) ?? [])
  const [nextKey, setNextKey] = useState(routine?.exercises.length ?? 0)
  const [selected, setSelected] = useState('')
  const [level, setLevel] = useState<string>(routine?.level ?? '')
  const [issue, setIssue] = useState('')
  const byId = new Map(catalog.map(exercise => [exercise.id, exercise]))
  function edit(key: number, property: keyof Omit<Draft, 'key' | 'exerciseId'>, next: string) {
    setDrafts(current => current.map(row => row.key === key ? { ...row, [property]: next } : row))
  }
  function move(index: number, delta: number) {
    setDrafts(current => {
      const destination = index + delta
      if (destination < 0 || destination >= current.length) return current
      const updated = [...current]
      ;[updated[index], updated[destination]] = [updated[destination]!, updated[index]!]
      return updated
    })
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    if (drafts.some(item => !byId.has(item.exerciseId))) {
      setIssue('Remove unavailable exercises before saving.')
      return
    }
    const draft = {
      name: value(data, 'name'), durationMinutes: optionalInt(value(data, 'duration')),
      level: value(data, 'level') || null,
      exercises: drafts.map(item => ({
        exerciseId: item.exerciseId, targetSets: optionalInt(item.sets), targetReps: optionalInt(item.reps),
        targetLoadKg: decimal(item.load) || null, targetSeconds: decimal(item.seconds) || null,
        targetMeters: decimal(item.meters) || null, restSeconds: optionalInt(item.rest),
      })),
      ...(routine ? { expectedRevision: routine.revision } : {}),
    }
    const validated = (routine ? routineEditSchema : routineWriteSchema).safeParse(draft)
    if (!validated.success) {
      setIssue(validated.error.issues[0]?.message ?? 'Check the routine details and exercise targets.')
      return
    }
    setIssue('')
    submit({ path: routine ? `/me/routines/${routine.id}` : '/me/routines', method: routine ? 'PATCH' : 'POST', body: validated.data })
  }
  return <form className="space-y-4 border-b border-border pb-4" onSubmit={save}>
    <h3 className="text-lg font-semibold">{routine ? 'Edit routine' : 'Build a routine'}</h3>
    <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-3">
      <label className={label}>Name<input name="name" className={field} required maxLength={200} defaultValue={routine?.name} /></label>
      <label className={label}>Duration (minutes)<input name="duration" className={field} type="number" min="1" max="1440" required defaultValue={routine?.durationMinutes ?? ''} /></label>
      <ValuePicker label="Level" name="level" value={level} onValueChange={setLevel} disabled={busy}
        options={[{ value: '', label: 'Unspecified' }, { value: 'beginner', label: 'Beginner' },
          { value: 'intermediate', label: 'Intermediate' }, { value: 'advanced', label: 'Advanced' }]} />
    </fieldset>
    <fieldset disabled={busy} className="space-y-3">
      <legend className="font-semibold">Exercise order and targets</legend>
      {drafts.map((item, index) => {
        const exercise = byId.get(item.exerciseId)
        const type = exercise?.measurementType
        return <fieldset key={item.key} className="space-y-2 border-t border-border pt-3">
          <legend className="font-medium">{index + 1}. {exercise?.name ?? 'Unavailable exercise'}</legend>
          {exercise && <div className="grid gap-2 sm:grid-cols-2">
            <label className={label}>Sets<input className={field} type="number" required min="1" max="100" value={item.sets} onChange={event => edit(item.key, 'sets', event.target.value)} /></label>
            {(type === 'bodyweight' || type === 'externalLoad') && <label className={label}>Reps per set<input className={field} type="number" required min="1" max="10000" value={item.reps} onChange={event => edit(item.key, 'reps', event.target.value)} /></label>}
            {type === 'externalLoad' && <label className={label}>Load (kg)<input className={field} inputMode="decimal" required value={item.load} onChange={event => edit(item.key, 'load', event.target.value)} /></label>}
            {type === 'timed' && <label className={label}>Duration (seconds)<input className={field} inputMode="decimal" required value={item.seconds} onChange={event => edit(item.key, 'seconds', event.target.value)} /></label>}
            {type === 'distance' && <label className={label}>Distance (meters)<input className={field} inputMode="decimal" required value={item.meters} onChange={event => edit(item.key, 'meters', event.target.value)} /></label>}
            <label className={label}>Rest (seconds, optional)<input className={field} type="number" min="0" max="86400" value={item.rest} onChange={event => edit(item.key, 'rest', event.target.value)} /></label>
          </div>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={index === 0} aria-label={`Move exercise ${index + 1} up`} onClick={() => move(index, -1)}>Move up</Button>
            <Button type="button" variant="outline" disabled={index === drafts.length - 1} aria-label={`Move exercise ${index + 1} down`} onClick={() => move(index, 1)}>Move down</Button>
            <Button type="button" variant="outline" aria-label={`Remove exercise ${index + 1}`} onClick={() => setDrafts(current => current.filter(row => row.key !== item.key))}>Remove</Button>
          </div>
        </fieldset>
      })}
      <ValuePicker label="Choose an exercise" value={selected} onValueChange={setSelected} searchable
        placeholder="Select exercise" options={catalog.map(exercise => ({
          value: exercise.id, label: exercise.name + ' - ' + types[exercise.measurementType],
        }))} />
      <Button type="button" variant="outline" disabled={!selected || drafts.length >= 100} onClick={() => {
        setDrafts(current => [...current, { key: nextKey, exerciseId: selected, sets: '1', reps: '', load: '', seconds: '', meters: '', rest: '' }])
        setNextKey(nextKey + 1)
        setSelected('')
      }}>Add exercise to routine</Button>
    </fieldset>
    {issue && <p role="alert" className="text-sm text-destructive">{issue}</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={busy || drafts.length === 0}>Save routine</Button>
      <Button variant="outline" type="button" onClick={cancel}>Cancel</Button></div>
  </form>
}

function TargetList({ rows }: { rows: Routine['exercises'] }) {
  return <ol className="list-decimal space-y-2 pl-5">{rows.map((row, index) => {
    const targets = [
      row.targetSets === null ? null : `${row.targetSets} sets`,
      row.targetReps === null ? null : `${row.targetReps} reps`,
      row.targetLoadKg === null ? null : `${row.targetLoadKg} kg`,
      row.targetSeconds === null ? null : `${row.targetSeconds} seconds`,
      row.targetMeters === null ? null : `${row.targetMeters} meters`,
      row.restSeconds === null ? null : `${row.restSeconds} seconds rest`,
    ].filter(Boolean)
    return <li key={`${row.exerciseId}-${index}`}>
      <span className="font-medium">{row.exerciseName}</span>
      <span className="block text-sm text-muted-foreground">{[types[row.measurementType], row.equipment, ...targets].filter(Boolean).join(' · ')}</span>
    </li>
  })}</ol>
}

function PrivateExercises({ session, owner }: { session: Session; owner: string }) {
  const client = useQueryClient()
  const [editor, setEditor] = useState<{ kind: 'exercise' | 'routine'; id?: string } | null>(null)
  const [archive, setArchive] = useState<Routine | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const exerciseKey = ['private', owner, 'exercises']
  const routineKey = ['private', owner, 'routines']
  const catalog = useQuery({
    queryKey: exerciseKey, retry: false,
    queryFn: ({ signal }) => session.requestPrivate('/me/exercises', exercisesResponseSchema.parse, signal),
  })
  const routines = useQuery({
    queryKey: routineKey, retry: false,
    queryFn: ({ signal }) => session.requestPrivate('/me/routines', routinesResponseSchema.parse, signal),
  })
  const writer = useMutation({
    retry: false,
    mutationFn: ({ method, path, body }: Action) => session.mutateMeal(method, path, body, exerciseMutationResponseSchema.parse),
    onSuccess: async () => {
      setEditor(null)
      setArchive(null)
      setNotice('Changes saved.')
      await Promise.all([client.invalidateQueries({ queryKey: exerciseKey }), client.invalidateQueries({ queryKey: routineKey })])
    },
    onError: (failure) => {
      const status = failure && typeof failure === 'object' && 'status' in failure ? failure.status : undefined
      setError(status === 409 ? 'This record changed. Reload the lists and reopen the editor before trying again.' : 'Changes could not be saved. Reload the lists to verify the current state.')
      if (status === 409) {
        setEditor(null)
        setArchive(null)
      }
    },
  })
  function submit(action: Action) { setNotice(''); setError(''); writer.mutate(action) }
  function open(kind: 'exercise' | 'routine', id?: string) { setNotice(''); setError(''); setArchive(null); setEditor({ kind, id }) }
  const exercises = catalog.data?.data ?? []
  const exercise = exercises.find(item => item.id === editor?.id)
  const routine = routines.data?.data.find(item => item.id === editor?.id)
  const measurementLocked = Boolean(exercise && routines.data?.data.some(item =>
    item.exercises.some(target => target.exerciseId === exercise.id)))
  return <div className="tempo-card-grid min-w-0">
    <header><h1 className="text-3xl font-semibold tracking-tight">Exercises and routines</h1>
      <p className="mt-2 text-muted-foreground">Browse the exercise catalog and build routines with ordered targets.</p></header>
    {(catalog.isError || routines.isError || error) && <div className="space-y-2">
      <p role="alert" className="text-destructive">{error || 'Exercises or routines are unavailable.'}</p>
      <Button variant="outline" onClick={() => { setError(''); void catalog.refetch(); void routines.refetch() }}>Reload lists</Button>
    </div>}
    {notice && <p role="status" className="text-success">{notice}</p>}
    <GlassPanel tone="solid"><section className="space-y-4" aria-labelledby="exercise-catalog">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="exercise-catalog" className="text-xl font-semibold">Exercise catalog</h2>
        <Button variant="outline" disabled={writer.isPending} onClick={() => open('exercise')}>Add exercise</Button>
      </div>
      {editor?.kind === 'exercise' && (!editor.id || exercise) && <ExerciseForm key={editor.id ?? 'new-exercise'}
        exercise={exercise} measurementLocked={measurementLocked} busy={writer.isPending} submit={submit} cancel={() => setEditor(null)} />}
      {catalog.isPending && <LoadingSkeleton label="Loading exercise catalog." shape="rows" />}
      {catalog.data?.data.length === 0 && <p>No exercises available. Add an exercise to start a routine.</p>}
      <ul className="divide-y divide-border">{exercises.map(item => <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
        <div className="min-w-0 break-words"><h3 className="font-semibold">{item.name}</h3>
          <p className="text-sm text-muted-foreground">{types[item.measurementType]} · {item.equipment ?? 'Equipment unspecified'}</p>
          {item.instructions && <details><summary className="min-h-11 cursor-pointer py-3 text-sm">Exercise instructions</summary><p className="text-sm">{item.instructions}</p></details>}</div>
        {item.editable && <Button variant="outline" disabled={writer.isPending} aria-label={`Edit ${item.name}`} onClick={() => open('exercise', item.id)}>Edit</Button>}
      </li>)}</ul>
    </section></GlassPanel>
    <GlassPanel tone="solid"><section className="space-y-4" aria-labelledby="routine-catalog">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="routine-catalog" className="text-xl font-semibold">Routines</h2>
        <Button variant="outline" disabled={writer.isPending || exercises.length === 0} onClick={() => open('routine')}>Build routine</Button>
      </div>
      {editor?.kind === 'routine' && (!editor.id || routine) && <RoutineForm key={editor.id ?? 'new-routine'}
        routine={routine} catalog={exercises} busy={writer.isPending} submit={submit} cancel={() => setEditor(null)} />}
      {routines.isPending && <LoadingSkeleton label="Loading routines." shape="rows" />}
      {routines.data?.data.length === 0 && <p>No routines available.</p>}
      {routines.data?.data.map(item => <article className="space-y-2 border-t border-border py-3" key={item.id}>
        <div className="flex flex-wrap items-start justify-between gap-2"><div>
          <h3 className="font-semibold">{item.name}</h3>
          <p className="text-sm text-muted-foreground">{item.durationMinutes === null ? 'Duration unspecified' : `${item.durationMinutes} minutes`}{item.level && ` · ${item.level}`}</p>
        </div>{item.editable && <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={writer.isPending} aria-label={`Edit ${item.name}`} onClick={() => open('routine', item.id)}>Edit</Button>
          <Button variant="outline" disabled={writer.isPending} aria-label={`Archive ${item.name}`} onClick={() => { setEditor(null); setArchive(item) }}>Archive</Button>
        </div>}</div>
        {archive?.id === item.id && <section className="space-y-2 border-l border-border pl-3" aria-label="Confirm routine archive">
          <p>Archive {archive.name}? Completed workout history stays available.</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={writer.isPending} onClick={() => submit({
              path: `/me/routines/${archive.id}`, method: 'DELETE',
              body: routineArchiveSchema.parse({ expectedRevision: archive.revision }),
            })}>Confirm archive</Button>
            <Button variant="outline" disabled={writer.isPending} onClick={() => setArchive(null)}>Cancel</Button>
          </div>
        </section>}
        <details><summary className="min-h-11 cursor-pointer py-3 text-sm">Routine targets</summary><TargetList rows={item.exercises} /></details>
        {item.shorterVariants.map(variant => <details key={variant.id} className="border-t border-border pt-2">
          <summary className="min-h-11 cursor-pointer py-2 font-medium">Reviewed shorter variant · {variant.name} · {variant.durationMinutes} minutes</summary>
          <TargetList rows={variant.exercises} />
        </details>)}
      </article>)}
    </section></GlassPanel>
  </div>
}

export function ExercisesPage({ session }: { session: Session }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  return snapshot.status === 'authenticated' ? <PrivateExercises key={snapshot.user.id} session={session} owner={snapshot.user.id} /> : null
}
