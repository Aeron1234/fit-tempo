import { GlassPanel } from '@/components/shared/GlassPanel'
import { FormValuePicker } from '@/components/shared/FormValuePicker'
import { ValuePicker } from '@/components/shared/ValuePicker'
import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { manualFoodSchema, revisionSchema, uuidSchema } from '@fit-tempo/contracts'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import type { Session } from '@/lib/api/session'

const named = z.object({ id: uuidSchema, name: z.string() })
const catalog = named.extend({
  categoryId: uuidSchema.nullable(),
  visibility: z.enum(['draft', 'approved', 'retired']),
  revision: revisionSchema,
})
const food = catalog.extend(manualFoodSchema.shape)
const exercise = catalog.extend({
  equipment: z.string().nullable(),
  instructions: z.string().nullable(),
  measurementType: z.enum(['externalLoad', 'bodyweight', 'timed', 'distance']),
})
const category = named.extend({ kind: z.enum(['food', 'exercise']) })
const users = z.object({ id: uuidSchema, email: z.string(), active: z.boolean(), role: z.enum(['admin', 'trainee']) })
const audit = z.object({ id: uuidSchema, action: z.string(), targetType: z.string(), targetId: uuidSchema.nullable(), occurredAt: z.string() })
const statistics = z.object({ users: z.number(), activeUsers: z.number(), foods: z.number(), exercises: z.number() })
const schemas = { users: z.array(users), foods: z.array(food), exercises: z.array(exercise), categories: z.array(category), audit: z.array(audit), statistics }
type Tab = keyof typeof schemas
const tabs: { id: Tab; label: string }[] = [
  { id: 'users', label: 'Accounts' }, { id: 'foods', label: 'Shared foods' }, { id: 'exercises', label: 'Shared exercises' },
  { id: 'categories', label: 'Categories' }, { id: 'audit', label: 'Audit history' }, { id: 'statistics', label: 'Statistics' },
]
const field = 'tempo-field w-full min-w-0'
const nutrients = {
  energyKcal: 'Energy (kcal)', proteinG: 'Protein (g)', carbsG: 'Carbs (g)',
  fatG: 'Fat (g)', fiberG: 'Fiber (g)', sodiumMg: 'Sodium (mg)',
} as const
const measurementLabels = { externalLoad: 'External load', bodyweight: 'Bodyweight', timed: 'Timed', distance: 'Distance' }
const pageSize = 25
type Item = z.infer<typeof food> | z.infer<typeof exercise> | z.infer<typeof category> | z.infer<typeof users>
type Change = { id?: string; body: object }

function Table({ headings, rows }: { headings: string[]; rows: ReactNode[][] }) {
  return <div className="tempo-scroll" role="region" aria-label={headings.join(", ")} tabIndex={0}><table className="tempo-table">
    <thead><tr>{headings.map(heading => <th scope="col" key={heading}>{heading}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody>
  </table></div>
}

function FoodFields({ value }: { value?: z.infer<typeof food> }) {
  const [basis, setBasis] = useState<string>(value?.basis.kind ?? 'per_100g')
  return <>
    <FormValuePicker label="Preparation" name="preparation" defaultValue={value?.preparation ?? 'unknown'}
      options={[{ value: 'unknown', label: 'Unspecified' }, { value: 'raw', label: 'Raw' }, { value: 'cooked', label: 'Cooked' }]} />
    <ValuePicker label="Nutrient basis" name="basis" value={basis} onValueChange={setBasis}
      options={[{ value: 'per_100g', label: 'Per 100 g' }, { value: 'per_serving', label: 'Per serving' }]} />
    {basis === 'per_serving' && <label>Serving weight (g)<input className={field} name="grams" inputMode="decimal" defaultValue={value?.basis.kind === 'per_serving' ? value.basis.grams ?? '' : ''} /></label>}
    <fieldset className="col-span-full space-y-2">
      <legend className="font-medium">Nutrient amounts</legend>
      <p className="text-sm text-muted-foreground">Leave unknown amounts blank. Enter 0 for a known zero.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(nutrients).map(([key, label]) => <label key={key}>{label}
          <input name={key} className={field} inputMode="decimal" defaultValue={value?.nutrients[key as keyof typeof nutrients] ?? ''} />
        </label>)}
      </div>
    </fieldset>
  </>
}

function CatalogEditor({ tab, value, categories, busy, onSave, onClose }: {
  tab: 'foods' | 'exercises' | 'categories'
  value?: Item
  categories: z.infer<typeof category>[]
  busy: boolean
  onSave: (change: Change) => void
  onClose: () => void
}) {
  const [error, setError] = useState('')
  const current = value && 'name' in value ? value : undefined
  const shared = current && 'visibility' in current ? current : undefined
  const categoryValue = current && 'kind' in current ? current : undefined
  const foodValue = shared && 'nutrients' in shared ? shared : undefined
  const exerciseValue = shared && 'equipment' in shared ? shared : undefined
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const text = (name: string) => String(form.get(name) ?? '').trim()
    const nullable = (name: string) => text(name) || null
    const sharedFields = { name: text('name'), visibility: text('visibility'), categoryId: nullable('categoryId') }
    const parsed = tab === 'categories'
      ? category.omit({ id: true }).safeParse({ name: text('name'), kind: text('kind') })
      : tab === 'foods'
        ? food.omit({ id: true, revision: true }).safeParse({
          ...sharedFields, preparation: text('preparation'),
          basis: text('basis') === 'per_100g' ? { kind: 'per_100g', grams: '100' } : { kind: 'per_serving', grams: nullable('grams') },
          nutrients: Object.fromEntries(Object.keys(nutrients).map(key => [key, nullable(key)])),
        })
        : exercise.omit({ id: true, revision: true }).safeParse({
          ...sharedFields, equipment: nullable('equipment'), instructions: nullable('instructions'), measurementType: text('measurementType'),
        })
    if (!parsed.success) {
      setError('Check the form. Nutrient amounts and serving weight must be valid decimals.')
      return
    }
    setError('')
    onSave({ id: current?.id, body: { ...parsed.data, ...(shared && { revision: shared.revision }) } })
  }
  const categoryKind = tab === 'foods' ? 'food' : 'exercise'
  const categoryOptions = categories.filter(item => item.kind === categoryKind)
    .map(item => ({ value: item.id, label: item.name }))
  if (shared?.categoryId && !categoryOptions.some(item => item.value === shared.categoryId)) {
    categoryOptions.unshift({ value: shared.categoryId, label: 'Current category' })
  }
  return <form onSubmit={submit} className="grid gap-3 border-y border-border py-4 sm:grid-cols-2">
    <h3 className="col-span-full font-semibold">{current ? `Edit ${current.name}` : `Add ${tab === 'categories' ? 'category' : tab === 'foods' ? 'food' : 'exercise'}`}</h3>
    <label>Name<input className={field} name="name" required maxLength={tab === 'categories' ? 120 : tab === 'foods' ? 200 : 240} defaultValue={current?.name} /></label>
    {tab === 'categories' ? <>
      {categoryValue && <input type="hidden" name="kind" value={categoryValue.kind} />}
      <FormValuePicker label="Catalog" name={categoryValue ? undefined : 'kind'} disabled={Boolean(categoryValue)}
        defaultValue={categoryValue?.kind ?? 'food'} options={[{ value: 'food', label: 'Foods' }, { value: 'exercise', label: 'Exercises' }]} />
    </> : <>
      <FormValuePicker label="Visibility" name="visibility" defaultValue={shared?.visibility ?? 'draft'}
        options={[{ value: 'draft', label: 'Draft' }, { value: 'approved', label: 'Approved' }, { value: 'retired', label: 'Retired' }]} />
      <FormValuePicker label="Category" name="categoryId" defaultValue={shared?.categoryId ?? ''} searchable
        options={[{ value: '', label: 'Uncategorized' }, ...categoryOptions]} />
      {tab === 'foods' ? <FoodFields value={foodValue} /> : <>
        <FormValuePicker label="Measurement" name="measurementType" defaultValue={exerciseValue?.measurementType ?? 'bodyweight'}
          options={Object.entries(measurementLabels).map(([value, label]) => ({ value, label }))} />
        <label>Equipment<input name="equipment" className={field} maxLength={240} defaultValue={exerciseValue?.equipment ?? ''} /></label>
        <label className="col-span-full">Instructions<textarea name="instructions" className={field} maxLength={4000} defaultValue={exerciseValue?.instructions ?? ''} /></label>
      </>}
    </>}
    {error && <p role="alert" className="col-span-full text-destructive">{error}</p>}
    <div className="col-span-full flex flex-wrap gap-2">
      <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
      <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
    </div>
  </form>
}

function AdminSection({ session, owner, tab }: { session: Session; owner: string; tab: Tab }) {
  const cache = useQueryClient()
  const [offset, setOffset] = useState(0)
  const [editing, setEditing] = useState<Item | 'new' | null>(null)
  const [confirmation, setConfirmation] = useState<z.infer<typeof users> | null>(null)
  const queryKey = ['private', owner, 'admin', tab, offset]
  const prefix = `/admin/${tab}`
  const query = useQuery({
    queryKey, retry: false,
    queryFn: ({ signal }) => session.requestPrivate(tab === 'statistics' ? prefix : `${prefix}?limit=${pageSize}&offset=${offset}`,
      z.object({ data: schemas[tab] }).parse, signal),
  })
  const categories = useQuery({
    queryKey: ['private', owner, 'admin', 'category-options'],
    enabled: tab === 'foods' || tab === 'exercises',
    queryFn: ({ signal }) => session.requestPrivate('/admin/categories?limit=100', z.object({ data: schemas.categories }).parse, signal),
  })
  const mutation = useMutation({
    mutationFn: ({ id, body }: Change) => session.mutateMeal(id ? 'PATCH' : 'POST', id ? `${prefix}/${id}` : prefix, body, value => value),
    onSuccess: async () => {
      const snapshot = session.getSnapshot()
      if (snapshot.status !== 'authenticated' || snapshot.user.id !== owner || snapshot.user.role !== 'admin') return
      setEditing(null)
      setConfirmation(null)
      await cache.invalidateQueries({ queryKey: ['private', owner, 'admin'] })
    },
  })
  const data = query.data?.data
  const list = Array.isArray(data) ? data : []
  const catalogTab = tab === 'foods' || tab === 'exercises' || tab === 'categories'
  const edit = (item: Item | 'new') => {
    mutation.reset()
    setEditing(item)
  }
  return <GlassPanel title={tabs.find(item => item.id === tab)?.label} tone="solid"><div className="space-y-4">
    {query.isPending && <p role="status">Loading…</p>}
    {query.isError && <div role="alert" className="space-y-2">
      <p>This section could not be loaded.</p>
      <Button type="button" variant="outline" onClick={() => void query.refetch()}>Try again</Button>
    </div>}
    {confirmation && <div className="space-y-3 border-y border-border py-4">
      <h3 className="font-semibold">{confirmation.active ? 'Suspend' : 'Reactivate'} {confirmation.email}?</h3>
      {confirmation.active && <p>Suspension signs this trainee out and cancels their queued optional emails.</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate({ id: confirmation.id, body: { active: !confirmation.active } })}>
          Confirm {confirmation.active ? 'suspension' : 'reactivation'}
        </Button>
        <Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => setConfirmation(null)}>Cancel</Button>
      </div>
    </div>}
    {data && tab === 'statistics' && !Array.isArray(data) && <dl className="tempo-ledger">
      {Object.entries({ Accounts: data.users, Active: data.activeUsers, 'Shared foods': data.foods, 'Shared exercises': data.exercises }).map(([label, count]) =>
        <div key={label} className="flex justify-between gap-3 py-2"><dt>{label}</dt><dd className="tabular-nums">{count}</dd></div>)}
    </dl>}
    {tab === 'users' && list.length > 0 && <Table headings={['Email', 'Role', 'Status', 'Action']} rows={(list as z.infer<typeof users>[]).map(item => [
      item.email, item.role, item.active ? 'Active' : 'Suspended',
      item.role === 'trainee' && <Button type="button" variant="outline" disabled={mutation.isPending}
        onClick={() => { mutation.reset(); setConfirmation(item) }}>{item.active ? 'Suspend' : 'Reactivate'}</Button>,
    ])} />}
    {tab === 'audit' && list.length > 0 && <Table headings={['Action', 'Target', 'Reference', 'Time']} rows={(list as z.infer<typeof audit>[]).map(item =>
      [item.action, item.targetType, item.targetId ?? 'Unavailable', new Date(item.occurredAt).toLocaleString()])} />}
    {catalogTab && data && <>
      <Button type="button" onClick={() => edit('new')}>Add {tab === 'categories' ? 'category' : tab === 'foods' ? 'food' : 'exercise'}</Button>
      {editing && <CatalogEditor key={editing === 'new' ? 'new' : editing.id}
        tab={tab} value={editing === 'new' ? undefined : editing} categories={categories.data?.data ?? []}
        busy={mutation.isPending} onSave={mutation.mutate} onClose={() => setEditing(null)} />}
      {list.length > 0 && <Table headings={['Name', tab === 'categories' ? 'Catalog' : 'Visibility', 'Action']}
        rows={(list as (z.infer<typeof food> | z.infer<typeof exercise> | z.infer<typeof category>)[]).map(item => [
          item.name, 'kind' in item ? item.kind : item.visibility,
          <Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => edit(item)}>Edit</Button>,
        ])} />}
    </>}
    {Array.isArray(data) && list.length === 0 && <p>No records on this page.</p>}
    {Array.isArray(data) && (offset > 0 || list.length === pageSize) && <div className="flex gap-2">
      <Button type="button" variant="outline" disabled={offset === 0 || mutation.isPending} onClick={() => setOffset(offset - pageSize)}>Previous page</Button>
      <Button type="button" variant="outline" disabled={list.length < pageSize || mutation.isPending} onClick={() => setOffset(offset + pageSize)}>Next page</Button>
    </div>}
    {mutation.isError && <div role="alert" className="space-y-2 text-destructive">
      {'status' in mutation.error && mutation.error.status === 409 ? <>
        <p>This record changed or conflicts with an existing record. Reload the section before trying again.</p>
        <Button type="button" variant="outline" onClick={async () => {
          if (!(await query.refetch()).isSuccess) return
          setEditing(null)
          setConfirmation(null)
          mutation.reset()
        }}>Reload records</Button>
      </> : <p>Changes could not be saved.</p>}
    </div>}
    {mutation.isSuccess && <p role="status" className="text-success">Changes saved.</p>}
  </div></GlassPanel>
}

function AdminWorkspace({ session, owner }: { session: Session; owner: string }) {
  const [tab, setTab] = useState<Tab>('users')
  return <div className="tempo-card-grid min-w-0">
    <h1 className="text-3xl font-semibold">Administration</h1>
    <nav aria-label="Administration sections" className="flex flex-wrap gap-2">
      {tabs.map(item => <Button key={item.id} type="button" variant={tab === item.id ? 'default' : 'outline'}
        aria-pressed={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</Button>)}
    </nav>
    <AdminSection key={tab} session={session} owner={owner} tab={tab} />
  </div>
}

export function AdminPage({ session }: { session: Session }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  if (snapshot.status !== 'authenticated') return null
  if (snapshot.user.role !== 'admin') return <p role="alert">Administrator access is required.</p>
  return <AdminWorkspace key={snapshot.user.id} session={session} owner={snapshot.user.id} />
}
