import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  foodLookupSchema, foodUnitSchema, ingredientPricesResponseSchema, ingredientPriceWriteSchema, mealWriteSchema,
  pantryResponseSchema, pantryWriteSchema, priceCurrencySchema, recipeEditSchema, recipesResponseSchema, recipeWriteSchema,
} from '@fit-tempo/contracts';
import { UnrecordedHatch } from '@/components/shared/UnrecordedHatch';
import { Button } from '@/components/ui/button';
import type { Session } from '@/lib/api/session';

const input = 'tempo-field w-full min-w-0';
const formPanel = 'tempo-form min-w-0 space-y-4';
const fieldLabel = 'grid min-w-0 gap-1.5 text-sm font-semibold';
const numberInput = `${input} text-right tempo-tabular`;
const issue = 'flex items-start gap-2 text-sm text-destructive';
type FoodRef = { foodId: string; foodName: string; nutrientRevision: number };
type Unit = typeof foodUnitSchema.options[number];
type Ingredient = FoodRef & { quantity: string; unit: Unit };
type Recipe = ReturnType<typeof recipesResponseSchema.parse>['data'][number];
type Lot = ReturnType<typeof pantryResponseSchema.parse>['data']['items'][number];
type Action = { method: 'POST' | 'PATCH' | 'DELETE'; path: string; body: object };
const field = (data: FormData, name: string) => String(data.get(name) ?? '').trim();
const decimal = (data: FormData, name: string) => field(data, name).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
const unitOptions = foodUnitSchema.options.map(unit => <option key={unit}>{unit}</option>);

function FoodPicker({ session, owner, select }: { session: Session; owner: string; select: (food: FoodRef) => void }) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const results = useQuery({
    queryKey: ['private', owner, 'foods', 'ingredients', submitted],
    enabled: submitted.length >= 2, retry: false,
    queryFn: ({ signal }) => session.requestPrivate(`/foods?q=${encodeURIComponent(submitted)}`, foodLookupSchema.parse, signal),
  });
  const foods = results.data?.data.filter(food => food.id !== null && food.revision !== undefined);
  return <form className={formPanel} onSubmit={event => {
    event.preventDefault();
    setSubmitted(query.trim());
  }}>
    <label className={fieldLabel}>Find a saved food
      <input type="search" className={input} value={query} minLength={2} maxLength={80} required onChange={event => setQuery(event.target.value)} />
    </label>
    <Button type="submit" variant="outline">Search</Button>
    {results.isFetching && <p className="text-sm text-muted-foreground" role="status">Searching saved foods.</p>}
    {results.isError && <p className={issue} role="alert"><AlertCircle size={16} className="shrink-0" aria-hidden="true" />Food search is unavailable.</p>}
    {foods?.length === 0 && <div className="space-y-3">
      <UnrecordedHatch />
      <p role="status">No saved foods found. You can add a food in the food catalog.</p>
    </div>}
    {Boolean(foods?.length) && <div className="flex flex-wrap gap-2">{foods?.map(food => <Button variant="outline" key={food.id} type="button" onClick={() => {
      if (food.id !== null && food.revision !== undefined) select({
        foodId: food.id, foodName: food.name, nutrientRevision: food.revision,
      });
      setQuery('');
      setSubmitted('');
    }}>{food.name}</Button>)}</div>}
  </form>;
}

function RecipeForm({ value, food, busy, submit }: {
  value: Recipe | null; food: FoodRef | null; busy: boolean; submit: (action: Action) => void;
}) {
  const [items, setItems] = useState<Ingredient[]>(value?.items ?? []);
  const [error, setError] = useState('');
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const payload = {
      name: field(data, 'name'), servings: decimal(data, 'servings'),
      cookedYieldGrams: decimal(data, 'yield') || null,
      prepMinutes: field(data, 'prep') ? Number(field(data, 'prep')) : null,
      items: items.map(({ foodId, nutrientRevision, quantity, unit }) => ({
        foodId, nutrientRevision, unit, quantity: quantity.trim().replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1'),
      })),
      steps: field(data, 'steps').split(/\r?\n/).map(line => line.trim()).filter(Boolean),
      ...(value ? { expectedRevision: value.revision } : {}),
    };
    const parsed = (value ? recipeEditSchema : recipeWriteSchema).safeParse(payload);
    if (!parsed.success) return setError('Enter a name, positive servings, and at least one valid ingredient quantity.');
    setError('');
    submit({ method: value ? 'PATCH' : 'POST', path: value ? `/me/recipes/${value.id}` : '/me/recipes', body: parsed.data });
  }
  return <form className={formPanel} onSubmit={onSubmit}>
    <h2 className="text-xl font-semibold">{value ? 'Edit recipe' : 'Add a recipe'}</h2>
    <fieldset className="grid gap-3 sm:grid-cols-2" disabled={busy}>
      <label className={fieldLabel}>Name<input name="name" className={input} required maxLength={200} defaultValue={value?.name} /></label>
      <label className={fieldLabel}>Servings<input name="servings" className={numberInput} required inputMode="decimal" defaultValue={value?.servings ?? '1'} /></label>
      <label className={fieldLabel}>Cooked yield (optional)
        <div className="relative min-w-0">
          <input name="yield" className={`${numberInput} pr-12`} aria-label="Cooked yield (g, optional)" inputMode="decimal" defaultValue={value?.cookedYieldGrams ?? ''} />
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground">g</span>
        </div>
      </label>
      <label className={fieldLabel}>Preparation time (minutes, optional)<input name="prep" type="number" min="0" max="1440" className={numberInput} defaultValue={value?.prepMinutes ?? ''} /></label>
      <label className={`${fieldLabel} sm:col-span-2`}>Instructions (one step per line)
        <textarea name="steps" className={input} defaultValue={value?.steps.join('\n')} />
      </label>
    </fieldset>
    <fieldset disabled={busy} className="space-y-2">
      <legend className="font-medium">Ingredients</legend>
      {items.map((item, i) => <div className="grid min-w-0 items-end gap-2 border-t border-border py-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]" key={i}>
        <span className="min-w-0 break-words font-medium">{item.foodName}</span>
        <label className={fieldLabel}>Quantity<input className={numberInput} inputMode="decimal" value={item.quantity} onChange={event => setItems(current =>
          current.map((entry, index) => index === i ? { ...entry, quantity: event.target.value } : entry))} /></label>
        <label className={fieldLabel}>Unit<select className={input} value={item.unit} onChange={event =>
          setItems(current => current.map((entry, index) => index === i ? { ...entry, unit: foodUnitSchema.parse(event.target.value) } : entry))}>{unitOptions}</select></label>
        <Button type="button" variant="outline" className="h-auto whitespace-normal break-words" onClick={() => setItems(current => current.filter((_item, index) => index !== i))}>Remove {item.foodName}</Button>
      </div>)}
      <Button type="button" variant="outline" disabled={!food || items.length >= 30} onClick={() => {
        if (food) setItems(current => [...current, { ...food, quantity: '1', unit: 'serving' }]);
      }}>Add {food?.foodName ?? 'selected food'}</Button>
    </fieldset>
    <p className="text-sm text-muted-foreground">Volume and count are kept in the entered unit. Gram conversions require a measured basis for the food.</p>
    {error && <p className={issue} role="alert"><AlertCircle size={16} className="shrink-0" aria-hidden="true" />{error}</p>}
    <Button disabled={busy} type="submit">Save recipe</Button>
  </form>;
}

function PantryForm({ lot, food, revision, submit, busy }: {
  lot: Lot | null; food: FoodRef | null; revision: number; submit: (action: Action) => void; busy: boolean;
}) {
  const [error, setError] = useState('');
  const selected = lot ?? food;
  return <form className={formPanel} onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = pantryWriteSchema.safeParse({
      foodId: selected?.foodId, quantity: decimal(data, 'quantity'), unit: field(data, 'unit'),
      expiresOn: field(data, 'expires') || null, expectedPantryRevision: revision, clientOperationId: crypto.randomUUID(),
    });
    if (!parsed.success) return setError('Select a saved food and enter a valid quantity and expiry date.');
    setError('');
    submit({ method: lot ? 'PATCH' : 'POST', path: lot ? `/me/pantry/${lot.id}` : '/me/pantry', body: parsed.data });
  }}>
    <h2 className="text-xl font-semibold">{lot ? 'Edit pantry lot' : 'Add a pantry lot'}</h2>
    <p>{selected?.foodName ?? 'Choose a saved food.'}</p>
    <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-3">
      <label className={fieldLabel}>Quantity<input className={numberInput} name="quantity" required inputMode="decimal" defaultValue={lot?.quantity ?? '1'} /></label>
      <label className={fieldLabel}>Unit<select className={input} name="unit" defaultValue={lot?.unit ?? 'g'}>{unitOptions}</select></label>
      <label className={fieldLabel}>Expiry (optional)<input type="date" className={input} name="expires" defaultValue={lot?.expiresOn ?? ''} /></label>
    </fieldset>
    {error && <p className={issue} role="alert"><AlertCircle size={16} className="shrink-0" aria-hidden="true" />{error}</p>}
    <Button disabled={!selected || busy} type="submit">Save pantry lot</Button>
  </form>;
}
function PriceForm({ food, busy, submit }: { food: FoodRef | null; busy: boolean; submit: (action: Action) => void }) {
  const [error, setError] = useState('');
  return <form className={formPanel} onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = ingredientPriceWriteSchema.safeParse({
      foodId: food?.foodId, amount: decimal(data, 'amount') || null, currency: field(data, 'currency'),
      unitQuantity: decimal(data, 'quantity'), unit: field(data, 'unit'), priceBasis: field(data, 'basis'),
      storeName: field(data, 'store') || null, recordedAt: new Date().toISOString(),
    });
    if (!parsed.success) return setError('Choose a food and enter a valid price basis. Leave the price blank if it is unknown.');
    setError('');
    submit({ method: 'POST', path: '/me/ingredient-prices', body: parsed.data });
  }}>
    <h2 className="text-xl font-semibold">Record a price</h2>
    <p>{food?.foodName ?? 'Choose a saved food.'}</p>
    <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
      <label className={fieldLabel}>Price (blank if unknown)<input className={numberInput} name="amount" inputMode="decimal" /></label>
      <label className={fieldLabel}>Currency<select className={input} name="currency">
        {priceCurrencySchema.options.map(currency => <option key={currency}>{currency}</option>)}
      </select></label>
      <label className={fieldLabel}>Price basis<select className={input} name="basis"><option value="unit">Unit</option><option value="package">Package</option></select></label>
      <label className={fieldLabel}>Quantity per unit or package<input className={numberInput} name="quantity" inputMode="decimal" defaultValue="1" required /></label>
      <label className={fieldLabel}>Quantity unit<select className={input} name="unit">{unitOptions}</select></label>
      <label className={fieldLabel}>Store (optional)<input className={input} name="store" maxLength={120} /></label>
    </fieldset>
    {error && <p className={issue} role="alert"><AlertCircle size={16} className="shrink-0" aria-hidden="true" />{error}</p>}
    <Button disabled={!food || busy} type="submit">Save price</Button>
  </form>;
}

function RecipeLog({ recipe, busy, submit }: { recipe: Recipe; busy: boolean; submit: (action: Action) => void }) {
  const [error, setError] = useState('');
  return <form className={formPanel} onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = mealWriteSchema.safeParse({
      clientOperationId: crypto.randomUUID(), occurredAt: new Date().toISOString(), mealType: field(data, 'mealType'),
      items: [{ recipeId: recipe.id, recipeRevision: recipe.revision, quantity: decimal(data, 'portion'), unit: 'serving' }],
    });
    if (!parsed.success) return setError('Enter a positive number of servings.');
    submit({ method: 'POST', path: '/me/meals', body: parsed.data });
  }}>
    <h2 className="text-lg font-semibold">Log {recipe.name} now</h2>
    <label className={fieldLabel}>Servings eaten<input className={numberInput} name="portion" inputMode="decimal" defaultValue="1" required /></label>
    <label className={fieldLabel}>Meal<select className={input} name="mealType" defaultValue="lunch">
      {['breakfast', 'lunch', 'dinner', 'snack'].map(type => <option key={type}>{type}</option>)}
    </select></label>
    <p className="text-sm text-muted-foreground">Confirming saves the recipe and nutrient snapshot to your meal history.</p>
    {error && <p className={issue} role="alert"><AlertCircle size={16} className="shrink-0" aria-hidden="true" />{error}</p>}
    <Button type="submit" disabled={busy}>Confirm meal</Button>
  </form>;
}

const sections = { recipes: 'Recipes', pantry: 'Pantry', prices: 'Prices' } as const;
type Section = keyof typeof sections;

function PrivateIngredients({ session, owner }: { session: Session; owner: string }) {
  const client = useQueryClient();
  const [section, setSection] = useState<Section>('recipes');
  const [food, setFood] = useState<FoodRef | null>(null);
  const [recipe, editRecipe] = useState<Recipe | null>(null);
  const [lot, editLot] = useState<{ value: Lot; revision: number } | null>(null);
  const [logging, setLogging] = useState<Recipe | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Action | null>(null);
  const recipes = useQuery({
    queryKey: ['private', owner, 'recipes'], enabled: section === 'recipes', retry: false,
    queryFn: ({ signal }) => session.requestPrivate('/me/recipes', recipesResponseSchema.parse, signal),
  });
  const pantry = useQuery({
    queryKey: ['private', owner, 'pantry'], enabled: section === 'pantry', retry: false,
    queryFn: ({ signal }) => session.requestPrivate('/me/pantry', pantryResponseSchema.parse, signal),
  });
  const prices = useQuery({
    queryKey: ['private', owner, 'ingredient-prices'], enabled: section === 'prices', retry: false,
    queryFn: ({ signal }) => session.requestPrivate('/me/ingredient-prices', ingredientPricesResponseSchema.parse, signal),
  });
  const query = section === 'recipes' ? recipes : section === 'pantry' ? pantry : prices;
  const revision = pantry.data?.data.revision;
  const write = useMutation({
    mutationFn: (action: Action) => session.mutateMeal(action.method, action.path, action.body, body => body),
    retry: false,
    onSuccess: async (_result, action) => {
      setPending(null);
      setNotice(action.path === '/me/meals' ? 'Meal logged.' : 'Saved.');
      editRecipe(null); editLot(null); setLogging(null);
      setFormVersion(version => version + 1);
      const keys = action.path === '/me/meals' ? ['meals', 'dashboard']
        : [section === 'prices' ? 'ingredient-prices' : section];
      await Promise.all(keys.map(key => client.invalidateQueries({ queryKey: ['private', owner, key] })));
    },
    onError: (error, action) => {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      if (status === 409) {
        setNotice('This record changed. Review the latest values before trying again.');
        editRecipe(null); editLot(null); setLogging(null);
        setFormVersion(version => version + 1);
        void query.refetch();
      } else if ((status === undefined || (typeof status === 'number' && status >= 500)) && 'clientOperationId' in action.body) {
        setPending(action);
        setNotice('The response was interrupted. You can retry the same submission.');
      } else setNotice('The change could not be confirmed. Review the saved records before retrying.');
    },
  });
  function submit(action: Action) {
    if (write.isPending) return;
    setPending(null);
    setNotice('');
    write.mutate(action);
  }
  const busy = write.isPending || pending !== null;
  const NoticeIcon = write.isError ? AlertCircle : Check;
  return <div className="min-w-0 space-y-7">
    <h1 className="text-3xl font-semibold tracking-tight">Recipes, pantry and prices</h1>
    <nav aria-label="Ingredient tools" className="flex flex-wrap gap-2">
      {(Object.keys(sections) as Section[]).map(key => <Button key={key} type="button" aria-pressed={section === key}
        disabled={busy} variant={section === key ? 'default' : 'outline'} onClick={() => {
          setSection(key); setNotice(''); editRecipe(null); editLot(null); setLogging(null); setFood(null);
        }}>{sections[key]}</Button>)}
    </nav>
    {notice && <p className={write.isError ? issue : 'flex items-start gap-2 text-sm text-success'} role={write.isError ? 'alert' : 'status'}>
      <NoticeIcon size={16} aria-hidden="true" className="shrink-0" />{notice}
    </p>}
    {pending && <div className="flex gap-2">
      <Button type="button" onClick={() => submit(pending)}>Retry same submission</Button>
      <Button type="button" variant="outline" onClick={() => { setPending(null); void query.refetch(); }}>Review saved records</Button>
    </div>}
    {query.isPending && <p className="text-sm text-muted-foreground" role="status">Loading {sections[section].toLowerCase()}.</p>}
    {query.isError && <div className="flex flex-wrap items-center gap-3" role="alert">
      <p className={issue}><AlertCircle size={16} className="shrink-0" aria-hidden="true" />Could not load {sections[section].toLowerCase()}.</p>
      <Button type="button" variant="outline" onClick={() => void query.refetch()}>Try again</Button>
    </div>}
    <FoodPicker key={section} session={session} owner={owner} select={setFood} />
    {section === 'recipes' && <>
      <RecipeForm key={recipe?.id ?? formVersion} value={recipe} food={food} busy={busy} submit={submit} />
      {recipe && <Button type="button" variant="outline" disabled={busy} onClick={() => editRecipe(null)}>Cancel editing</Button>}
      {logging && <RecipeLog key={logging.id} recipe={logging} busy={busy} submit={submit} />}
      {recipes.data?.data.length === 0 && <div className="tempo-section space-y-3"><UnrecordedHatch /><p role="status">No recipes saved yet.</p></div>}
      {recipes.data?.data.map(row => <article key={row.id} className="tempo-section min-w-0 space-y-3">
        <h2 className="text-xl font-semibold">{row.name}</h2>
        <dl className="tempo-ledger grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
          <dt>Servings</dt><dd className="tempo-tabular text-right">{row.servings}</dd>
          <dt>Cooked yield</dt><dd className="tempo-tabular text-right">{row.cookedYieldGrams === null ? 'Unknown' : `${row.cookedYieldGrams} g`}</dd>
          {row.prepMinutes !== null && <><dt>Preparation time</dt><dd className="tempo-tabular text-right">{row.prepMinutes} min</dd></>}
        </dl>
        <ul className="list-disc pl-5">{row.items.map((item, index) => <li key={index}>
          {item.foodName}: {item.quantity} {item.unit}{item.gramsPerUnit && ` (${item.gramsPerUnit} g per ${item.unit})`}
        </li>)}</ul>
        {row.steps.length > 0 && <ol className="list-decimal pl-5">{row.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => setLogging(row)}>Log a portion</Button>
          {row.editable && <>
            <Button type="button" variant="outline" disabled={busy} onClick={() => editRecipe(row)}>Edit</Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => {
              if (window.confirm(`Archive ${row.name}?`)) submit({ method: 'DELETE', path: `/me/recipes/${row.id}`, body: { expectedRevision: row.revision } });
            }}>Archive</Button>
          </>}
        </div>
      </article>)}
    </>}
    {section === 'pantry' && revision !== undefined && <>
      <PantryForm key={lot?.value.id ?? formVersion} lot={lot?.value ?? null} food={food} revision={lot?.revision ?? revision} busy={busy} submit={submit} />
      {lot && <Button type="button" variant="outline" disabled={busy} onClick={() => editLot(null)}>Cancel editing</Button>}
      {pantry.data?.data.items.length === 0 && <div className="tempo-section space-y-3"><UnrecordedHatch /><p role="status">No pantry lots saved yet.</p></div>}
      {pantry.data?.data.items.map(row => <article key={row.id} className="tempo-section min-w-0 space-y-3">
        <h2 className="text-lg font-semibold">{row.foodName}</h2>
        <dl className="tempo-ledger grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
          <dt>Quantity</dt><dd className="tempo-tabular text-right">{row.quantity} {row.unit}</dd>
          <dt>Expiry</dt><dd className="tempo-tabular text-right">{row.expiresOn ?? 'Unknown'}</dd>
        </dl>
        <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => editLot({ value: row, revision })}>Edit</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => {
            if (window.confirm(`Remove this lot of ${row.foodName}?`)) submit({ method: 'DELETE', path: `/me/pantry/${row.id}`,
              body: { expectedPantryRevision: revision, clientOperationId: crypto.randomUUID() } });
          }}>Remove</Button>
        </div>
      </article>)}
    </>}
    {section === 'prices' && <>
      <PriceForm key={formVersion} food={food} busy={busy} submit={submit} />
      {prices.data?.data.length === 0 && <div className="tempo-section space-y-3"><UnrecordedHatch /><p role="status">No prices recorded. Ingredient prices are unknown.</p></div>}
      {prices.data?.data.map(row => <article key={row.id} className="tempo-section min-w-0 space-y-3">
        <h2 className="text-lg font-semibold">{row.foodName}</h2>
        <dl className="tempo-ledger grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
          <dt>Price per {row.priceBasis} ({row.unitQuantity} {row.unit})</dt>
          <dd className="tempo-tabular text-right">{row.amount === null ? 'Price unknown' : `${row.currency} ${row.amount}`}</dd>
          <dt>Store</dt><dd className="max-w-60 break-words text-right">{row.storeName ?? 'Unknown'}</dd>
          <dt>Recorded date</dt><dd className="tempo-tabular text-right">{row.recordedAt.slice(0, 10)}</dd>
        </dl>
      </article>)}
    </>}
  </div>;
}

export function IngredientsPage({ session }: { session: Session }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return snapshot.status === 'authenticated'
    ? <PrivateIngredients key={snapshot.user.id} owner={snapshot.user.id} session={session} /> : null;
}
