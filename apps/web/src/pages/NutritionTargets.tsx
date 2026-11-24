import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { estimateNutritionTargets, nutritionTargetsResponseSchema,
  nutritionTargetWriteSchema, positiveDecimalSchema } from '@fit-tempo/contracts'
import { Button } from '@/components/ui/button'
import { GlassPanel } from '@/components/shared/GlassPanel'
import type { Session } from '@/lib/api/session'
import { dashboardResponse } from './dashboard-response'

const metrics = [
  ['energyKcal', 'Calories', 'kcal', 'calories'],
  ['proteinG', 'Protein', 'g', 'protein'],
  ['carbsG', 'Carbohydrates', 'g', 'carbs'],
  ['fatG', 'Fat', 'g', 'fat'],
] as const
const field = 'tempo-field min-h-12 w-full min-w-0 px-3 py-2 text-base'
const profileResponse = z.object({ data: z.object({ displayName: z.string().nullable(), heightCm: positiveDecimalSchema.nullable() }) })
type TargetValues = Pick<z.infer<typeof nutritionTargetWriteSchema>, typeof metrics[number][0]>
type TargetWrite = z.infer<typeof nutritionTargetWriteSchema>
type Saved = z.infer<typeof nutritionTargetsResponseSchema>['data']['targets']
type LatestWeight = { weightKg: string; localDate: string }
type EstimateInputs = Parameters<typeof estimateNutritionTargets>[0]
type Review = { revision: number; previous: Saved; initial: TargetValues | null; maintenanceKcal?: number }

function EstimateForm({ height, weight, onEstimate }: {
  height: string | null | undefined; weight: LatestWeight | null | undefined;
  onEstimate: (estimate: NonNullable<ReturnType<typeof estimateNutritionTargets>>) => void;
}) {
  const [error, setError] = useState('')
  const id = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  function estimate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const result = estimateNutritionTargets({
      heightCm: Number(fields.get('height')), weightKg: Number(fields.get('weight')), age: Number(fields.get('age')),
      equation: fields.get('equation') as EstimateInputs['equation'],
      activity: fields.get('activity') as EstimateInputs['activity'], goal: fields.get('goal') as EstimateInputs['goal'],
    })
    if (!result) {
      setError('This estimate is outside the supported ranges for your details and goal. Review your inputs or enter targets manually.')
      return
    }
    onEstimate(result)
  }
  return <form className="grid gap-3" method="post" aria-labelledby={id} onSubmit={estimate} onChange={() => setError('')}>
    <h3 ref={heading} id={id} tabIndex={-1} className="font-semibold">Estimate your daily targets</h3>
    <p className="text-sm">Confirm the measurements for this estimate. Edits here apply only to this calculation.</p>
    <label className="grid gap-1">Height (cm)
      <input className={field} name="height" type="number" inputMode="decimal" min={100} max={250} step="any" required defaultValue={height ?? ''} />
      <span className="text-sm text-muted-foreground">Saved height: {height ? height + ' cm' : 'Unavailable'}.</span>
    </label>
    <label className="grid gap-1">Weight (kg)
      <input className={field} name="weight" type="number" inputMode="decimal" min={30} max={300} step="any" required defaultValue={weight?.weightKg} />
      <span className="text-sm text-muted-foreground">{weight ? `Latest recorded: ${weight.weightKg} kg on ${weight.localDate}.` : 'Latest recorded weight unavailable.'}</span>
    </label>
    <label className="grid gap-1">Age (years)
      <input className={field} name="age" type="number" min={19} max={78} required />
      <span className="text-sm text-muted-foreground">Age, height and weight affect estimated resting energy needs.</span>
    </label>
    <label className="grid gap-1">Sex used in the calorie equation
      <select className={field} name="equation" defaultValue="" required>
        <option value="" disabled>Choose a formula input</option><option value="female">Female</option><option value="male">Male</option>
      </select>
      <span className="text-sm text-muted-foreground">The resting energy equation uses a different coefficient for each option.</span>
    </label>
    <label className="grid gap-1">Typical activity
      <select className={field} name="activity" defaultValue="" required>
        <option value="" disabled>Choose your activity level</option>
        <option value="low">Mostly seated or lightly active</option>
        <option value="moderate">Active most days</option>
        <option value="high">Very active most days</option>
      </select>
      <span className="text-sm text-muted-foreground">Activity adjusts resting energy to estimate daily maintenance.</span>
    </label>
    <label className="grid gap-1">Goal
      <select className={field} name="goal" defaultValue="maintain">
        <option value="maintain">Maintain weight</option><option value="build">Build muscle</option><option value="lose">Lose weight</option>
      </select>
    </label>
    <details className="text-sm">
      <summary className="min-h-11 cursor-pointer py-3">How the estimate works</summary>
      <p>Mifflin–St Jeor estimates resting energy. We adjust for typical activity, then apply a 5% increase for building muscle or a 10% decrease for weight loss. The starting calorie split is 25% protein, 45% carbohydrates and 30% fat.</p>
    </details>
    <label className="flex min-h-12 items-start gap-2 py-2">
      <input type="checkbox" name="eligibility" className="mt-1" required />
      <span>I’m 19–78, and I’m using the general adult estimate. For pregnancy, breastfeeding or clinical nutrition needs, use manual targets.</span>
    </label>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <Button type="submit">Calculate estimate</Button>
  </form>
}

function TargetReview({ review, onSave, onCancel, busy }: {
  review: Review; onSave: (values: TargetValues) => void; onCancel: () => void; busy: boolean;
}) {
  const [values, setValues] = useState(() => Object.fromEntries(metrics.map(([key]) =>
    [key, review.initial?.[key]?.toString() ?? ''])) as Record<keyof TargetValues, string>)
  const hasAllValues = Object.values(values).every(value => value !== '')
  const implied = Number(values.proteinG) * 4 + Number(values.carbsG) * 4 + Number(values.fatG) * 9
  const calories = Number(values.energyKcal)
  const mismatch = hasAllValues && Math.abs(calories - implied) >= Math.max(50, calories * 0.05)
  const id = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  return <form className="grid gap-3" method="post" aria-labelledby={id} onSubmit={event => {
    event.preventDefault()
    onSave({ energyKcal: calories, proteinG: Number(values.proteinG), carbsG: Number(values.carbsG), fatG: Number(values.fatG) })
  }}>
    <h3 id={id} ref={heading} tabIndex={-1} className="font-semibold">{review.maintenanceKcal === undefined ? 'Enter daily targets' : 'Review estimated daily targets'}</h3>
    {review.maintenanceKcal !== undefined && <p>Estimated maintenance: {review.maintenanceKcal} kcal per day. Adjust any target before saving.</p>}
    <fieldset disabled={busy} className="grid min-w-0 gap-3">
      <legend className="sr-only">Daily target amounts</legend>
      {metrics.map(([key, label, unit]) => <div key={key}
        className={review.previous ? 'grid min-w-0 gap-2 sm:grid-cols-2 sm:items-end' : 'grid min-w-0 gap-1'}>
        <label className="grid min-w-0 gap-1">{label} ({unit})
          <input name={key} type="number" inputMode="numeric" step={1} min={key === 'energyKcal' ? 1 : 0}
            max={key === 'energyKcal' ? 20_000 : 5_000} required className={field} value={values[key]}
            onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))} />
        </label>
        {review.previous && <p className="text-sm text-muted-foreground sm:py-3">Saved target: {review.previous[key]} {unit}</p>}
      </div>)}
    </fieldset>
    {mismatch && <p className="text-sm">These macros add up to about {implied} kcal, compared with your {calories} kcal target. You can adjust the values or save them as entered.</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Confirm and save targets'}</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
    </div>
  </form>
}

export function NutritionTargets({ session, owner }: { session: Session; owner: string }) {
  const cache = useQueryClient()
  const [estimating, setEstimating] = useState(false)
  const [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [retry, setRetry] = useState<TargetWrite | null>(null)
  const inFlight = useRef(false)
  const key = ['private', owner, 'nutrition-targets']
  const targets = useQuery({ queryKey: key, queryFn: ({ signal }) =>
    session.requestPrivate('/me/nutrition-targets', nutritionTargetsResponseSchema.parse, signal) })
  const profile = useQuery({ queryKey: ['private', owner, 'profile'], enabled: estimating, queryFn: ({ signal }) =>
    session.requestPrivate('/me/profile', profileResponse.parse, signal) })
  const progress = useQuery({ queryKey: ['private', owner, 'dashboard', ''],
    enabled: Boolean(targets.data?.data.targets), queryFn: ({ signal }) =>
      session.requestPrivate('/me/dashboard', dashboardResponse.parse, signal) })
  const saved = targets.data?.data
  const active = saved?.targets
  const day = progress.data?.meta.mode === 'local' ? progress.data.data : undefined
  const applicable = saved?.dayTargets === undefined ? active : saved.dayTargets
  const dayTarget = day && applicable && day.date >= applicable.effectiveFrom &&
    (!saved?.localDate || day.date === saved.localDate) ? applicable : null
  const hasNewerWeight = active?.savedAt && saved?.latestWeight &&
    Date.parse(saved.latestWeight.measuredAt) > Date.parse(active.savedAt)
  const write = useMutation({
    mutationFn: (body: TargetWrite) => session.mutateMeal('POST', '/me/nutrition-targets', body, nutritionTargetsResponseSchema.parse),
    onSuccess: async () => {
      setReview(null)
      setRetry(null)
      setNotice('Nutrition targets saved.')
      const snapshot = session.getSnapshot()
      if (snapshot.status === 'authenticated' && snapshot.user.id === owner) {
        await cache.invalidateQueries({ queryKey: key, exact: true })
      }
    },
    onError: async (failure, body) => {
      const status = failure && typeof failure === 'object' && 'status' in failure ? failure.status : undefined
      if (status === 409) {
        setReview(null)
        setError('Targets changed elsewhere. Review the current targets before making another change.')
        const snapshot = session.getSnapshot()
        if (snapshot.status === 'authenticated' && snapshot.user.id === owner) {
          await cache.invalidateQueries({ queryKey: key, exact: true })
        }
      } else if (typeof status !== 'number' || status >= 500) {
        setRetry(body)
        setError('Could not confirm the save. Retry the same submission to check whether it succeeded.')
      } else {
        setError(failure instanceof Error ? failure.message : 'Could not save nutrition targets.')
      }
    },
    onSettled: () => { inFlight.current = false },
  })
  function submit(body: TargetWrite) {
    if (inFlight.current) return
    inFlight.current = true
    setRetry(null)
    setError('')
    write.mutate(body)
  }

  return <GlassPanel title="Nutrition targets" tone="solid">
    <div className="space-y-4">
      {targets.isPending && <LoadingSkeleton label="Loading nutrition targets." shape="ledger" count={4} />}
      {targets.isError && <div role="alert" className="space-y-2">
        <p>Could not load nutrition targets.</p>
        <Button variant="outline" onClick={() => void targets.refetch()}>Try again</Button>
      </div>}
      {active && <div className="space-y-2">
        <p>Latest saved targets effective {active.effectiveFrom}.</p>
        {hasNewerWeight && <p className="text-sm">A newer weight was logged on {saved.latestWeight?.localDate}. You can recalculate and compare targets before saving.</p>}
        {progress.isPending && <LoadingSkeleton label="Loading today’s nutrition." shape="ledger" count={4} />}
        {progress.isError && <p role="status">Today’s nutrition progress is unavailable.</p>}
        {day && saved?.localDate === day.date && !dayTarget && <p className="text-sm">No targets apply to {day.date}.</p>}
        {day && dayTarget && <p className="text-sm">
          {day.date} · {day.status === 'unrecorded' ? 'No meals recorded' : day.status === 'complete' ? 'Log marked complete' : 'Log in progress'}
        </p>}
        {dayTarget && dayTarget !== active && dayTarget.effectiveFrom !== active.effectiveFrom &&
          <p className="text-sm">This day uses targets effective {dayTarget.effectiveFrom}.</p>}
        <dl className="divide-y divide-border">
          {metrics.map(([key, label, unit, slot]) => {
            const target = (dayTarget ?? active)[key]
            const nutrient = dayTarget ? day?.[slot] : undefined
            return <div key={key} className="grid gap-1 py-2">
              <dt className="font-medium">{label}</dt>
              <dd>{!nutrient ? `${target} ${unit} daily target` : day?.status === 'unrecorded' ?
                `Not recorded · ${target} ${unit} target` : nutrient.knownSubtotal === null ?
                  `Logged amount unknown · ${target} ${unit} target` : `${nutrient.knownSubtotal} of ${target} ${unit} logged`}
                {nutrient && nutrient.missingItemCount > 0 && <span className="block text-sm text-muted-foreground">
                  Incomplete · {nutrient.missingItemCount} {nutrient.missingItemCount === 1 ? 'item missing this value' : 'items missing this value'}
                </span>}
                {nutrient?.knownSubtotal != null && target > 0 &&
                  <progress aria-hidden="true" max={target} value={Math.min(target, Number(nutrient.knownSubtotal))}
                    className="block h-2 w-full accent-primary" />}
              </dd>
            </div>
          })}
        </dl>
      </div>}
      {saved && !saved.targets && <p>Set daily calories, protein, carbohydrates and fat.</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {retry && <Button onClick={() => submit(retry)} disabled={write.isPending}>Retry the same save</Button>}
      {saved && !review && !estimating && <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => { setError(''); setNotice(''); setEstimating(true) }}>
          {saved.targets ? 'Recalculate from measurements' : 'Estimate my targets'}
        </Button>
        <Button type="button" variant="outline" onClick={() => {
          setError(''); setNotice(''); setReview({ revision: saved.revision, previous: saved.targets, initial: saved.targets })
        }}>{saved.targets ? 'Edit targets manually' : 'Enter targets manually'}</Button>
      </div>}
      {saved && estimating && <>
        {profile.isPending ? <LoadingSkeleton label="Loading saved measurements." shape="form" count={2} /> :
          <EstimateForm height={profile.data?.data.heightCm} weight={saved.latestWeight}
            onEstimate={estimate => {
              setEstimating(false)
              setReview({ revision: saved.revision, previous: saved.targets, initial: estimate, maintenanceKcal: estimate.maintenanceKcal })
            }} />}
        <Button type="button" variant="outline" onClick={() => setEstimating(false)}>Back to targets</Button>
      </>}
      {review && <TargetReview review={review} busy={write.isPending || retry !== null} onCancel={() => setReview(null)} onSave={values => {
        const input = nutritionTargetWriteSchema.safeParse({ ...values, revision: review.revision, clientOperationId: crypto.randomUUID() })
        if (input.success) submit(input.data)
        else setError('Enter whole numbers within the supported range for every target.')
      }} />}
    </div>
  </GlassPanel>
}
