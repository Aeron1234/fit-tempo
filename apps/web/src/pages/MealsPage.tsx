import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFieldArray, useForm, useWatch, type UseFormReturn } from 'react-hook-form';
import { AlertCircle, Check } from 'lucide-react';
import { z } from 'zod';
import {
  catalogFoodSchema, dayStatusResponseSchema, foodLookupSchema, foodUnitSchema, localDateSchema,
  mealEditSchema, mealTypeSchema, mealWriteSchema, revisionSchema, uuidSchema,
} from '@fit-tempo/contracts';
import { ValuePicker } from '@/components/shared/ValuePicker';
import { GlassPanel } from '@/components/shared/GlassPanel';
import { UnrecordedHatch } from '@/components/shared/UnrecordedHatch';
import { Button } from '@/components/ui/button';
import type { Session } from '@/lib/api/session';
import { mealsResponse, type MealRow } from './meal-response';
import { canonicalMealDecimal, mealWallTime, resolveMealInstant } from './meal-form';

const metrics = [
  ['energyKcal', 'Calories', 'kcal'], ['proteinG', 'Protein', 'g'], ['carbsG', 'Carbohydrates', 'g'],
  ['fatG', 'Fat', 'g'], ['fiberG', 'Fiber', 'g'], ['sodiumMg', 'Sodium', 'mg'],
] as const;
type Metric = typeof metrics[number][0];
const mutationResponse = z.object({ data: z.object({ id: uuidSchema, revision: revisionSchema }) });
type FoodCandidate = z.infer<typeof catalogFoodSchema>;
type Fields = Record<Metric, string> & {
  kind: 'manual' | 'catalog' | 'saved';
  itemId: string; foodId: string; foodRevision: number; name: string;
  preparation: 'raw' | 'cooked' | 'unknown'; basis: 'per_serving' | 'per_100g'; grams: string;
  quantity: string; unit: z.infer<typeof foodUnitSchema>;
};
type MealFormValues = { mealType: z.infer<typeof mealTypeSchema>; wallTime: string; items: Fields[] };
type MealAction = { method: 'POST' | 'PATCH' | 'DELETE' | 'PUT'; path: string; body: object; done: string };

const input = 'tempo-field w-full min-w-0';
const numberInput = `${input} text-right tempo-tabular`;
const issue = 'flex items-start gap-2 text-sm text-destructive';
const typeLabels = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };
const blankItem: Fields = {
  kind: 'manual', itemId: '', foodId: '', foodRevision: 0, name: '', preparation: 'unknown', basis: 'per_serving',
  grams: '', quantity: '1', unit: 'serving', energyKcal: '', proteinG: '', carbsG: '', fatG: '', fiberG: '', sodiumMg: '',
};

function basisLabel(basis: { kind: string; grams: string | null }) {
  if (basis.kind === 'per_100g') return 'Per 100 g';
  return basis.grams ? `Per serving (${basis.grams} g)` : 'Per serving (gram weight unknown)';
}

function FoodPicker({ owner, session, select, enabled, selected }: {
  owner: string; session: Session; select: (food: FoodCandidate & { id: string; revision: number }) => void; enabled: boolean;
  selected: { id: string; label: string };
}) {
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState('');
  const result = useQuery({
    queryKey: ['private', owner, 'foods', 'meal-catalog', submitted],
    enabled: enabled && submitted.length >= 2,
    retry: false,
    queryFn: ({ signal }) => session.requestPrivate(
      `/foods?q=${encodeURIComponent(submitted)}`, foodLookupSchema.parse, signal,
    ),
  });
  const choices = result.data?.data.flatMap(food => {
    const revision = 'revision' in food ? revisionSchema.safeParse(food.revision) : undefined;
    return food.id && revision?.success ? [{ ...food, id: food.id, revision: revision.data }] : [];
  });
  return <ValuePicker label="Catalog food name" placeholder="Choose a catalog food"
    value={selected.id} selectedLabel={selected.label} searchable disabled={!enabled}
    search={search} onSearchChange={setSearch} loading={result.isFetching}
    onSearchSubmit={draft => {
      const term = draft.trim();
      if (term.length < 2) return;
      if (submitted === term) void result.refetch();
      else setSubmitted(term);
    }}
    emptyMessage={submitted.length < 2 ? 'Enter at least two characters and search.' : 'No saved catalog food matches. Manual entry is available.'}
    error={result.isError ? 'Catalog unavailable. Manual entry is available.' : undefined}
    options={(choices ?? []).map(food => ({ value: food.id, label: food.name + ' (' + basisLabel(food.basis) + ')' }))}
    onValueChange={id => {
      const food = choices?.find(choice => choice.id === id);
      if (!food) return;
      select(food);
      setSearch('');
      setSubmitted('');
    }} />;
}

function ItemFields({ form, index, owner, session, locked, remove }: {
  form: UseFormReturn<MealFormValues>; index: number; owner: string; session: Session;
  locked: boolean; remove: (() => void) | undefined;
}) {
  const { register, control, setValue } = form;
  const item = useWatch({ control, name: `items.${index}` });
  const prefix = `items.${index}` as const;
  const basis = item.basis === 'per_100g' ? { kind: item.basis, grams: '100' } : { kind: item.basis, grams: item.grams || null };
  return (
    <fieldset className="min-w-0 space-y-4 border-t border-border pt-4" disabled={locked}>
      <legend className="pr-2 font-semibold">Item {index + 1}</legend>
      {item.kind === 'saved' ? <>
        <p>{item.name}, {item.quantity} {item.unit}, {basisLabel(basis)}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setValue(prefix, { ...item, kind: 'manual' })}>Replace with manual details</Button>
          <Button type="button" variant="outline" onClick={() => setValue(prefix, { ...blankItem, kind: 'catalog' })}>Replace with catalog food</Button>
        </div>
      </> : <>
        <ValuePicker label="Food source" value={item.kind} disabled={locked}
          onValueChange={value => setValue(`${prefix}.kind`, value === 'catalog' ? 'catalog' : 'manual')}
          options={[{ value: 'manual', label: 'Manual entry' }, { value: 'catalog', label: 'Saved catalog food' }]} />
        {item.kind === 'catalog' ? <>
          {item.foodId && <p>{item.name}, {basisLabel(basis)}</p>}
          <FoodPicker session={session} owner={owner} enabled={!locked} selected={{ id: item.foodId, label: item.name }} select={food => {
            setValue(prefix, {
              ...blankItem, kind: 'catalog', foodId: food.id, foodRevision: food.revision, name: food.name,
              basis: food.basis.kind, grams: food.basis.grams ?? '',
              unit: food.basis.kind === 'per_100g' ? 'g' : 'serving',
              quantity: food.basis.kind === 'per_100g' ? '100' : '1',
            });
          }} />
        </> : <>
          <label className="grid min-w-0 gap-1.5 text-sm font-semibold">Food name<input required maxLength={200} className={input} {...register(`${prefix}.name`)} /></label>
          <ValuePicker label="Nutrition label basis" value={item.basis} disabled={locked}
            onValueChange={value => setValue(`${prefix}.basis`, value === 'per_100g' ? 'per_100g' : 'per_serving')}
            options={[{ value: 'per_serving', label: 'Per serving' }, { value: 'per_100g', label: 'Per 100 g' }]} />
          <details className="border-t border-border">
            <summary className="min-h-11 cursor-pointer py-3 font-medium">Preparation and nutrition (optional)</summary>
            <div className="space-y-3">
              <ValuePicker label="Preparation" value={item.preparation} disabled={locked}
                onValueChange={value => setValue(`${prefix}.preparation`, value === 'raw' || value === 'cooked' ? value : 'unknown')}
                options={[{ value: 'unknown', label: 'Unknown' }, { value: 'raw', label: 'Raw' }, { value: 'cooked', label: 'Cooked' }]} />
          {item.basis === 'per_serving' && <label className="relative grid min-w-0 gap-1.5 text-sm font-semibold">Grams per serving, if known
            <input inputMode="decimal" className={`${numberInput} pr-12`} {...register(`${prefix}.grams`)} />
              <span aria-hidden="true" className="pointer-events-none absolute bottom-0 right-3 flex min-h-10 items-center text-muted-foreground">g</span>
          </label>}
          <p className="text-sm text-muted-foreground">Leave unknown nutrients blank. Enter 0 for a known zero.</p>
          <div className="grid gap-2 sm:grid-cols-3">{metrics.map(([key, label, unit]) => (
            <label key={key} className="grid min-w-0 gap-1.5 text-sm font-semibold">
              {label}
              <div className="relative min-w-0">
                <input inputMode="decimal" className={`${numberInput} pr-14`} aria-label={`${label} (${unit})`} {...register(`${prefix}.${key}`)} />
                <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground">{unit}</span>
              </div>
            </label>
          ))}</div>
            </div>
          </details>
        </>}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid min-w-0 gap-1.5 text-sm font-semibold">Amount eaten
            <div className="relative min-w-0">
              <input required inputMode="decimal" className={`${numberInput} pr-16`} {...register(`${prefix}.quantity`)} />
              <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground">{item.unit}</span>
            </div></label>
          <ValuePicker label="Unit" value={item.unit} disabled={locked}
            onValueChange={value => setValue(`${prefix}.unit`, foodUnitSchema.parse(value))}
            options={foodUnitSchema.options.map(unit => ({ value: unit, label: unit }))} />
        </div>
        <p className="text-sm text-muted-foreground">Use the serving count or a measured weight when available. Unverified conversions leave totals unknown.</p>
      </>}
      {remove && <Button type="button" variant="outline" onClick={remove}>Remove item {index + 1}</Button>}
    </fieldset>
  );
}

function writeItem(item: Fields) {
  if (item.kind === 'saved') return { itemId: item.itemId };
  const portion = { quantity: canonicalMealDecimal(item.quantity), unit: item.unit };
  if (item.kind === 'catalog') return { ...portion, foodId: item.foodId, nutrientRevision: item.foodRevision };
  return {
    ...portion, manual: {
      name: item.name, preparation: item.preparation,
      basis: item.basis === 'per_100g' ? { kind: item.basis, grams: '100' }
        : { kind: item.basis, grams: canonicalMealDecimal(item.grams) || null },
      nutrients: Object.fromEntries(metrics.map(([key]) => [key, canonicalMealDecimal(item[key]) || null])),
    },
  };
}

function defaultForm(date: string, timeZone: string, meal?: MealRow): MealFormValues {
  const now = mealWallTime(new Date().toISOString(), timeZone);
  return {
    mealType: meal?.mealType ?? 'lunch',
    wallTime: meal ? mealWallTime(meal.occurredAt, timeZone) : now.startsWith(date) ? now : `${date}T12:00`,
    items: meal?.items.map(({ id, snapshot }) => ({
      ...blankItem, kind: 'saved', itemId: id, name: snapshot.foodName, preparation: snapshot.preparation,
      basis: snapshot.basis.kind, grams: snapshot.basis.grams ?? '',
      quantity: snapshot.quantity.value, unit: snapshot.quantity.unit,
      ...Object.fromEntries(metrics.map(([key]) => [key, snapshot.basisNutrients[key] ?? ''])),
    })) ?? [{ ...blankItem }],
  };
}

function MealForm({ meal, date, timeZone, owner, session, locked, close, review }: {
  meal?: MealRow; date: string; timeZone: string; owner: string; session: Session;
  locked: boolean; close: () => void; review: (action: MealAction) => void;
}) {
  const defaults = defaultForm(date, timeZone, meal);
  const form = useForm<MealFormValues>({ defaultValues: defaults });
  const { control, handleSubmit, register } = form;
  const { fields, append, remove } = useFieldArray({ control, name: 'items' });
  const [error, setError] = useState('');
  const mealType = useWatch({ control, name: 'mealType' });
  return <GlassPanel tone="solid"><form className="min-w-0 space-y-5" onSubmit={handleSubmit(fields => {
    const occurredAt = meal && fields.wallTime === defaults.wallTime
      ? meal.occurredAt : resolveMealInstant(fields.wallTime, timeZone);
    if (!occurredAt) {
      setError('Enter a valid, unambiguous local date and time.');
      return;
    }
    const body = {
      clientOperationId: crypto.randomUUID(), mealType: fields.mealType, occurredAt, timeZone,
      items: fields.items.map(writeItem),
      ...(meal ? { expectedRevision: meal.revision } : {}),
    };
    const parsed = (meal ? mealEditSchema : mealWriteSchema).safeParse(body);
    if (!parsed.success) {
      setError('Check the food selection, names, quantities, and decimal nutrition values.');
      return;
    }
    setError('');
    review({
      method: meal ? 'PATCH' : 'POST', path: meal ? `/me/meals/${meal.id}` : '/me/meals',
      body: parsed.data, done: meal ? 'Changes saved.' : 'Meal logged.',
    });
  })}>
    <h2 className="text-xl font-semibold">{meal ? 'Edit meal' : 'Log a meal'}</h2>
    <fieldset className="grid gap-3 sm:grid-cols-2" disabled={locked}>
      <ValuePicker label="Meal type" value={mealType} disabled={locked}
        onValueChange={value => form.setValue('mealType', mealTypeSchema.parse(value))}
        options={mealTypeSchema.options.map(value => ({ value, label: typeLabels[value] }))} />
      <label className="grid min-w-0 gap-1.5 text-sm font-semibold">Date and time ({timeZone})
        <input required type="datetime-local" className={input} {...register('wallTime')} />
      </label>
    </fieldset>
    {fields.map((field, index) => <ItemFields key={field.id} form={form} index={index} owner={owner} session={session}
      locked={locked} remove={fields.length > 1 ? () => remove(index) : undefined} />)}
    {error && <p className={issue} role="alert"><AlertCircle size={16} className="shrink-0" aria-hidden="true" />{error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={locked || fields.length >= 30} onClick={() => append({ ...blankItem })}>Add item</Button>
      <Button type="submit" disabled={locked}>Review {meal ? 'changes' : 'meal'}</Button>
      <Button type="button" variant="outline" disabled={locked} onClick={close}>Cancel</Button>
    </div>
  </form></GlassPanel>;
}

function MealHistoryCard({ meal, edit, deleteMeal, disabled }: {
  meal: MealRow; edit: () => void; deleteMeal: () => void; disabled: boolean;
}) {
  const displayedTime = mealWallTime(meal.occurredAt, meal.timeZone).slice(11);
  return <article className="min-w-0 space-y-4 border-t border-border pt-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <div className="flex items-center gap-3">
          <h3 className="text-xl font-semibold tracking-tight">{typeLabels[meal.mealType]}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{displayedTime} ({meal.timeZone})</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={disabled} onClick={edit}>Edit</Button>
        <Button type="button" variant="outline" disabled={disabled} onClick={deleteMeal}>Delete</Button>
      </div>
    </div>
    <ul className="divide-y divide-border border-y border-border">{meal.items.map(({ id, snapshot, recipeSnapshot }) => <li className="min-w-0 break-words py-3" key={id}>
      <div className="flex flex-wrap justify-between gap-x-3">
        <span className="font-semibold">{snapshot.foodName}</span>
        <span className="tempo-tabular text-right">{snapshot.quantity.value} {snapshot.quantity.unit}</span>
      </div>
      <span className="block text-sm text-muted-foreground">
        {basisLabel(snapshot.basis)}, {snapshot.preparation === 'unknown' ? 'preparation unknown' : snapshot.preparation}
      </span>
      {recipeSnapshot && <details className="mt-2 text-sm">
        <summary className="cursor-pointer font-medium">Saved recipe details</summary>
        <p>{recipeSnapshot.servings} servings</p>
        <p>{recipeSnapshot.yield.unit === 'g'
          ? `Cooked yield: ${recipeSnapshot.yield.value} g` : 'Cooked weight unknown'}</p>
        <ul className="list-disc pl-5">{recipeSnapshot.ingredients.map((ingredient, index) =>
          <li key={index}>{ingredient.foodName}: {ingredient.quantity.value} {ingredient.quantity.unit}</li>)}</ul>
      </details>}
    </li>)}</ul>
    <dl className="tempo-ledger divide-y divide-border border-t border-border">
      {metrics.map(([key, label, unit]) => {
        const amount = meal.totals[key];
        const missing = meal.items.filter(({ snapshot }) => snapshot.consumedNutrients[key] === null).length;
        return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 py-2" key={key}>
          <dt className="text-sm font-medium">{label}</dt>
          <dd className="tempo-tabular break-words text-right font-semibold">{amount === null ? 'Unavailable' : `${amount} ${unit}`}</dd>
          {missing > 0 && <dd className="col-span-full text-sm text-muted-foreground">
            {amount !== null && 'Known subtotal. '}
            {missing} {missing === 1 ? 'item missing' : 'items missing'} this value
          </dd>}
        </div>;
      })}
    </dl>
  </article>;
}

const dayLabels = {
  unrecorded: 'No nutrition recorded.',
  partial: 'Nutrition recorded. This day is open for changes.',
  complete: 'Nutrition marked complete.',
};

function isKnownRejection(error: unknown) {
  return error instanceof Error && 'status' in error && typeof error.status === 'number' &&
    error.status >= 400 && error.status < 500 && error.status !== 408;
}

const confirmLabels = {
  POST: 'Confirm and log meal',
  PATCH: 'Confirm changes',
  DELETE: 'Confirm deletion',
  PUT: 'Confirm day status',
};

function MealsForOwner({ session, owner }: { session: Session; owner: string }) {
  const queryClient = useQueryClient();
  const [date, setDate] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const [editor, setEditor] = useState<'create' | MealRow>();
  const [action, setAction] = useState<MealAction>();
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState<'ambiguous' | 'rejected'>();
  const submitting = useRef(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const cursor = cursors.at(-1);
  const query = useQuery({
    queryKey: ['private', owner, 'meals', date, cursor], retry: false,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (date) params.set('date', date);
      if (cursor) params.set('cursor', cursor);
      return session.requestPrivate(`/me/meals?${params}`, mealsResponse.parse, signal);
    },
  });
  const day = query.data?.data;
  const nextCursor = day?.nextCursor;
  async function refreshNutrition() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['private', owner, 'meals'] }),
      queryClient.invalidateQueries({ queryKey: ['private', owner, 'dashboard'] }),
    ]);
  }
  const save = useMutation({
    mutationFn: (next: MealAction) => session.mutateMeal(
      next.method, next.path, next.body,
      body => next.method === 'PUT' ? dayStatusResponseSchema.parse(body) : mutationResponse.parse(body),
    ),
    retry: false,
    onSuccess: async (_result, next) => {
      setNotice(next.done);
      setEditor(undefined);
      setAction(undefined);
      setCursors([]);
      await refreshNutrition();
    },
    onError: async error => {
      const known = isKnownRejection(error);
      setFailed(known ? 'rejected' : 'ambiguous');
      if (known) await refreshNutrition();
    },
    onSettled: () => { submitting.current = false; },
  });
  const locked = Boolean(action) || save.isPending;
  useEffect(() => { if (action) reviewHeading.current?.focus(); }, [action]);
  function review(next: MealAction) {
    setNotice('');
    setFailed(undefined);
    setAction(next);
  }
  return <div className="tempo-card-grid min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Meals</h1>
        <Button type="button" disabled={!day || Boolean(editor) || locked} onClick={() => {
          setNotice('');
          setEditor('create');
        }}>Log a meal</Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid min-w-0 w-48 max-w-full gap-1.5 text-sm font-semibold">Date
          <input type="date" className={input} value={date || day?.date || ''} disabled={locked || Boolean(editor)}
            onChange={event => {
              if (!event.target.value || localDateSchema.safeParse(event.target.value).success) {
                setDate(event.target.value);
                setCursors([]);
                setNotice('');
              }
            }} />
        </label>
        {day && <p className="text-sm text-muted-foreground self-end pb-2">Recorded day time zone: {day.timeZone}</p>}
      </div>
      {!day && query.isFetching && <GlassPanel title="Meal history" tone="solid"><p className="text-sm" role="status">Loading meals...</p></GlassPanel>}
      {query.isError && <GlassPanel title="Meal history unavailable" tone="solid"><div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
        <p className="flex items-start gap-2"><AlertCircle size={16} className="shrink-0" aria-hidden="true" />Meal history could not be loaded.</p>
        <Button type="button" variant="outline" onClick={() => void query.refetch()}>Try again</Button>
      </div></GlassPanel>}
      {notice && <p className="flex items-start gap-2 text-sm text-success" role="status"><Check size={16} className="shrink-0" aria-hidden="true" />{notice}</p>}
      {editor && day && <MealForm key={editor === 'create' ? 'create' : editor.id} date={day.date}
        timeZone={editor === 'create' ? day.preferredTimeZone : editor.timeZone}
        meal={editor === 'create' ? undefined : editor} owner={owner} session={session} locked={locked}
        close={() => setEditor(undefined)} review={review} />}
      {action && <GlassPanel tone="solid"><div className="min-w-0 space-y-4" aria-label="Review nutrition changes">
        <h2 ref={reviewHeading} tabIndex={-1} className="text-lg font-semibold">{confirmLabels[action.method]}</h2>
        {action.method === 'DELETE' ? <p>Remove this meal from your log?</p>
          : action.method === 'PUT' && day ? <p>{day.status === 'complete' ? 'Reopen' : 'Mark complete'} the nutrition log for {day.date}?
            {day.status === 'unrecorded' && ' This records zero intake for the day.'}</p>
          : <p>Confirm the amounts and nutrient values above before saving.</p>}
        {(action.method === 'POST' || action.method === 'PATCH' || action.method === 'DELETE') && (
          <p className="text-sm text-muted-foreground">Saving a change reopens any affected day marked complete.</p>
        )}
        {failed === 'ambiguous' && <p className="flex items-start gap-2 text-sm text-warning" role="alert">
          <AlertCircle size={16} className="shrink-0" aria-hidden="true" />
          {action.method === 'PUT'
            ? 'The result could not be confirmed. Check the current day before trying again.'
            : 'The result could not be confirmed. Retry this same submission to avoid duplicates.'}
        </p>}
        {failed === 'rejected' && <p className={issue} role="alert"><AlertCircle size={16} className="shrink-0" aria-hidden="true" />The request was rejected. Review the current history before submitting again.</p>}
        <div className="flex flex-wrap gap-2">
          {failed === 'ambiguous' && action.method === 'PUT' && <Button type="button" disabled={save.isPending} onClick={() => {
            setAction(undefined);
            setFailed(undefined);
            void refreshNutrition();
          }}>Check current day</Button>}
          {failed !== 'rejected' && !(failed === 'ambiguous' && action.method === 'PUT') && <Button type="button" disabled={save.isPending} onClick={() => {
            if (submitting.current) return;
            submitting.current = true;
            setFailed(undefined);
            save.mutate(action);
          }}>{save.isPending ? 'Saving...' : failed === 'ambiguous' ? 'Retry same submission' : confirmLabels[action.method]}</Button>}
          {failed !== 'ambiguous' && <Button type="button" variant="outline" disabled={save.isPending} onClick={() => {
            if (failed === 'rejected' && action.method === 'PATCH') setEditor(undefined);
            setFailed(undefined);
            setAction(undefined);
          }}>{failed === 'rejected' ? 'Back to history' : 'Cancel confirmation'}</Button>}
        </div>
      </div></GlassPanel>}
      {day && <GlassPanel tone="solid"><div className="min-w-0 space-y-4" aria-label="Meal history">
        {query.isFetching && <p className="text-sm" role="status">Loading meals...</p>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Meal history</h2>
            <p className="text-sm text-muted-foreground">{dayLabels[day.status]}</p>
          </div>
          <Button type="button" variant="outline" disabled={locked || Boolean(editor)} onClick={() => review({
            method: 'PUT', path: `/me/tracking-days/${day.date}/nutrition`,
            body: { state: day.status === 'complete' ? 'reopen' : 'complete' },
            done: day.status === 'complete' ? 'Day reopened.' : 'Day marked complete.',
          })}>{day.status === 'complete' ? 'Reopen day' : 'Mark day complete'}</Button>
        </div>
        {!day.meals.length && <div className="space-y-2 border-t border-border pt-4"><UnrecordedHatch /><p>{cursor ? 'No meals on this page.' : day.status === 'complete' ? 'Confirmed zero intake for this day.' : 'No meals logged for this day.'}</p></div>}
        {day.meals.map(meal => <MealHistoryCard key={meal.id} meal={meal} disabled={locked || Boolean(editor)}
          edit={() => { setNotice(''); setEditor(meal); }}
          deleteMeal={() => review({
            method: 'DELETE', path: `/me/meals/${meal.id}`,
            body: { clientOperationId: crypto.randomUUID(), expectedRevision: meal.revision },
            done: 'Meal deleted.',
          })} />)}
        {(cursor || nextCursor) && <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={!cursor || locked || Boolean(editor)}
            onClick={() => setCursors(current => current.slice(0, -1))}>Previous meals</Button>
          <Button type="button" variant="outline" disabled={!nextCursor || locked || Boolean(editor)}
            onClick={() => { if (nextCursor) { setDate(day.date); setCursors(current => [...current, nextCursor]); } }}>More meals</Button>
        </div>}
      </div></GlassPanel>}
  </div>;
}

export function MealsPage({ session }: { session: Session }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  if (snapshot.status !== 'authenticated') return null;
  return <MealsForOwner key={snapshot.user.id} owner={snapshot.user.id} session={session} />;
}
