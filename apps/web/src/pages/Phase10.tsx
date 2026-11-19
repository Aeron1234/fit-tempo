import { useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check } from 'lucide-react'
import { useForm, useWatch } from 'react-hook-form'
import { foodLookupSchema, manualFoodResponseSchema, manualFoodSchema } from '@fit-tempo/contracts'
import { UnrecordedHatch } from '@/components/shared/UnrecordedHatch'
import { Button } from '@/components/ui/button'
import type { Session } from '@/lib/api/session'

const metrics = [
  ['energyKcal', 'Calories', 'kcal'], ['proteinG', 'Protein', 'g'],
  ['carbsG', 'Carbohydrates', 'g'], ['fatG', 'Fat', 'g'],
  ['fiberG', 'Fiber', 'g'], ['sodiumMg', 'Sodium', 'mg'],
] as const
type Nutrient = typeof metrics[number][0]
type ManualFields = Record<Nutrient, string> & {
  name: string; preparation: 'raw' | 'cooked' | 'unknown'; basis: 'per_100g' | 'per_serving'; grams: string
}
const input = 'tempo-field w-full min-w-0'
const fieldLabel = 'grid min-w-0 gap-1.5 text-sm font-semibold'
function optionalDecimal(value: string) {
  const trimmed = value.trim()
  return trimmed.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1') || null
}

function ManualFood({ session, owner }: { session: Session; owner: string }) {
  const client = useQueryClient()
  const [notice, setNotice] = useState<{ text: string; failure: boolean } | null>(null)
  const { register, handleSubmit, reset, control } = useForm<ManualFields>({
    defaultValues: { name: '', preparation: 'unknown', basis: 'per_serving', grams: '',
      energyKcal: '', proteinG: '', carbsG: '', fatG: '', fiberG: '', sodiumMg: '' },
  })
  const perServing = useWatch({ control, name: 'basis' }) === 'per_serving'
  const save = useMutation({
    mutationFn: (food: object) => session.createManualFood(food, manualFoodResponseSchema.parse),
    retry: false,
    onSuccess: () => {
      reset()
      setNotice({ text: 'Food saved to your catalog.', failure: false })
      void client.invalidateQueries({ queryKey: ['private', owner, 'foods'] })
    },
    onError: () => setNotice({ text: 'Save could not be confirmed. Search your catalog before retrying.', failure: true }),
  })
  return (
    <form className="tempo-form grid gap-4" onSubmit={handleSubmit(fields => {
      const parsed = manualFoodSchema.safeParse({
        name: fields.name,
        preparation: fields.preparation,
        basis: fields.basis === 'per_100g' ? { kind: 'per_100g', grams: '100' }
          : { kind: 'per_serving', grams: optionalDecimal(fields.grams) },
        nutrients: Object.fromEntries(metrics.map(([key]) => [key, optionalDecimal(fields[key])])),
      })
      if (!parsed.success) {
        setNotice({ text: 'Enter a food name and valid decimal values. Leave unknown values blank.', failure: true })
        return
      }
      setNotice(null)
      save.mutate(parsed.data)
    })}>
      <h2 className="text-xl font-semibold">Add a food manually</h2>
      <label className={fieldLabel}>Food name<input className={input} maxLength={200} required {...register('name')} /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={fieldLabel}>Preparation<select className={input} {...register('preparation')}>
          <option value="unknown">Unknown</option><option value="raw">Raw</option><option value="cooked">Cooked</option>
        </select></label>
        <label className={fieldLabel}>Nutrient basis<select className={input} {...register('basis')}>
          <option value="per_serving">Per serving</option><option value="per_100g">Per 100 g</option>
        </select></label>
      </div>
      {perServing && <label className={fieldLabel}>Grams per serving, if known
        <div className="relative min-w-0">
          <input className={`${input} pr-12 text-right tempo-tabular`} inputMode="decimal" {...register('grams')} />
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground">g</span>
        </div>
      </label>}
      <p className="text-sm text-muted-foreground">Leave unknown nutrients blank. Enter 0 only when the value is known to be zero.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        {metrics.map(([key, label, unit]) => <label key={key} className={fieldLabel}>
          {label}
          <div className="relative min-w-0">
            <input className={`${input} pr-14 text-right tempo-tabular`} aria-label={`${label} (${unit})`} inputMode="decimal" {...register(key)} />
            <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground">{unit}</span>
          </div>
        </label>)}
      </div>
      <div><Button type="submit" disabled={save.isPending}>Save food</Button></div>
      {notice && (notice.failure
        ? <p className="flex gap-2 text-sm text-destructive" role="alert"><AlertCircle size={16} className="shrink-0" aria-hidden="true" />{notice.text}</p>
        : <p className="flex gap-2 text-sm text-success" role="status"><Check size={16} className="shrink-0" aria-hidden="true" />{notice.text}</p>)}
    </form>
  )
}

export function FoodCatalogPage({ session }: { session: Session }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const owner = snapshot.status === 'authenticated' ? snapshot.user.id : undefined
  const [value, setValue] = useState('')
  const [mode, setMode] = useState<'search' | 'barcode'>('search')
  const [path, setPath] = useState('')
  const [validation, setValidation] = useState('')
  const result = useQuery({
    queryKey: ['private', owner, 'foods', path],
    enabled: Boolean(owner && path), retry: false,
    queryFn: ({ signal }) => session.requestPrivate(path, foodLookupSchema.parse, signal),
  })
  if (!owner) return null
  return (
    <div className="min-w-0 space-y-8">
      <h1 className="text-3xl font-semibold tracking-tight">Food catalog</h1>
      <form className="tempo-form grid min-w-0 items-end gap-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]" onSubmit={event => {
        event.preventDefault()
        const query = value.trim()
        if (mode === 'barcode' && !/^(?:\d{8}|\d{12,14})$/.test(query)) {
          setValidation('Enter an 8-, 12-, 13-, or 14-digit barcode.')
          return
        }
        if (mode === 'search' && query.length < 2) {
          setValidation('Enter at least two characters.')
          return
        }
        setValidation('')
        const next = mode === 'search' ? `/foods?q=${encodeURIComponent(query)}` : `/foods/barcode/${query}`
        if (path === next) void result.refetch()
        else setPath(next)
      }}>
        <label className={fieldLabel}>Look up by<select className={input} value={mode} onChange={event => {
          setMode(event.target.value === 'barcode' ? 'barcode' : 'search')
          setPath('')
          setValidation('')
        }}>
          <option value="search">Food name</option><option value="barcode">Barcode</option>
        </select></label>
        <label className={fieldLabel}>{mode === 'barcode' ? 'Barcode' : 'Food name'}
          <input className={input} value={value} maxLength={80} required
              inputMode={mode === 'barcode' ? 'numeric' : 'search'} onChange={event => setValue(event.target.value)} />
        </label>
        <Button type="submit">Look up</Button>
        {validation && <p className="flex gap-2 text-sm text-destructive sm:col-span-full" role="alert"><AlertCircle size={16} className="shrink-0" aria-hidden="true" />{validation}</p>}
      </form>
      {result.isFetching && <p className="text-sm text-muted-foreground" role="status">Looking up foods...</p>}
      {result.isError && <p className="flex gap-2 text-sm text-destructive" role="alert"><AlertCircle size={16} className="shrink-0" aria-hidden="true" />Lookup failed. You can add the food manually below.</p>}
      {result.data?.meta.status === 'not_found' && <div className="tempo-section space-y-3">
        <UnrecordedHatch />
        <p className="text-sm" role="status">No matching food found. You can add it manually below.</p>
      </div>}
      {result.data?.meta.status === 'unavailable' && <p className="flex gap-2 text-sm text-warning" role="status"><AlertCircle size={16} className="shrink-0" aria-hidden="true" />A food data source is unavailable. You can add a food manually below.</p>}
      {result.data && result.data.data.length > 0 && <section aria-labelledby="food-results-heading" className="min-w-0 space-y-3">
        <h2 id="food-results-heading" className="text-xl font-semibold">Search results</h2>
        <div className="tempo-scroll max-h-[32rem] overflow-auto" tabIndex={0} role="region" aria-labelledby="food-results-heading">
          <table className="tempo-table w-full min-w-[46rem] border-separate border-spacing-0 bg-card text-sm">
            <thead className="sticky top-0 z-10 bg-card">
              <tr>
                <th scope="col" className="min-w-48 border-b border-border px-3 py-2 text-left">Food, basis and source</th>
                {metrics.map(([key, label, unit]) => <th key={key} scope="col" className="border-b border-border px-3 py-2 text-right">
                  {label} <span className="block font-normal text-muted-foreground">{unit}</span>
                </th>)}
              </tr>
            </thead>
            <tbody>
              {result.data.data.map(food => <tr className="align-top" key={`${food.source.source}:${food.source.sourceRecordId}`}>
                <th scope="row" className="border-b border-border px-3 py-2 text-left font-normal border-l-[3px] border-l-transparent focus-within:border-l-mark">
                  <div className="break-words font-semibold">{food.name}</div>
                  <div className="text-muted-foreground">
                    {food.basis.kind === 'per_100g' ? 'Per 100 g' : 'Per serving'}
                    {food.basis.kind === 'per_serving' && (food.basis.grams ? ` (${food.basis.grams} g)` : ', gram conversion unavailable')}
                  </div>
                  <div className="text-muted-foreground">{food.preparation === 'unknown' ? 'Preparation unknown' : food.preparation}</div>
                  <div className="mt-1">
                    {food.attribution.url ? <a className="break-words font-semibold text-accent underline underline-offset-4" href={food.attribution.url} target="_blank" rel="noreferrer">
                      {food.attribution.label}
                    </a> : food.attribution.label}
                    <span className="block text-muted-foreground">{food.attribution.license}</span>
                  </div>
                </th>
                {metrics.map(([key]) => {
                  const value = food.nutrients[key]
                  return <td key={key} className="tempo-tabular border-b border-border px-3 py-2 text-right">
                    {value === null ? <span className="text-muted-foreground">Unknown</span> : value}
                  </td>
                })}
              </tr>)}
            </tbody>
          </table>
        </div>
      </section>}
      <ManualFood session={session} owner={owner} />
    </div>
  )
}
