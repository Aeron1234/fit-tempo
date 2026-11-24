import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { GlassPanel } from '@/components/shared/GlassPanel'
import { FormValuePicker } from '@/components/shared/FormValuePicker'
import { ValuePicker } from '@/components/shared/ValuePicker'
import { useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  foodRecognitionCapabilitiesResponseSchema, foodRecognitionResponseSchema, mealTypeSchema,
  revisionSchema, uuidSchema, type MealWrite,
} from '@fit-tempo/contracts';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import type { Session } from '@/lib/api/session';
import { mealWallTime } from './meal-form';
import { reviewedMealDraft, type RecognitionCandidateDraft } from './food-recognition-form';
import { apiBase } from '@/lib/api/client';
import { preferencesResponse } from './profile-preferences';
import { ProductPhotoFlow } from './ProductPhotoFlow';
import { labelNutrients, type ProductLabel } from './product-photo';

const path = '/me/ai/food-suggestions';
const field = 'tempo-field min-w-0 w-full px-3';
const savedMeal = z.object({ data: z.object({ id: uuidSchema, revision: revisionSchema }) });
function failureStatus(error: unknown) {
  return typeof error === 'object' && error && 'status' in error ? error.status : undefined;
}

function RecognitionReview({ session, owner }: { session: Session; owner: string }) {
  const client = useQueryClient();
  const [candidates, setCandidates] = useState<RecognitionCandidateDraft[]>([]);
  const [fixtureSelection, setFixtureSelection] = useState('');
  const [reviewed, setReviewed] = useState<MealWrite | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const submitting = useRef(false);
  const capability = useQuery({
    queryKey: ['private', owner, 'food-recognition'],
    queryFn: ({ signal }) => session.requestPrivate(path, foodRecognitionCapabilitiesResponseSchema.parse, signal),
    retry: false,
  });
  const preferences = useQuery({
    queryKey: ['private', owner, 'preferences'],
    queryFn: ({ signal }) => session.requestPrivate('/me/preferences', preferencesResponse.parse, signal),
    retry: false,
  });
  const recognition = useMutation({
    mutationFn: (fixtureId: string) => session.mutateMeal('POST', path, { fixtureId }, foodRecognitionResponseSchema.parse),
    onSuccess: ({ data }) => {
      setCandidates(data.candidates.map(item => ({ name: item.name, estimate: item.portionGrams, grams: '' })));
      if (!data.candidates.length) setError('No foods could be suggested. You can still log a meal manually.');
    },
    onError: failure => {
      setError(failureStatus(failure) === 429
        ? 'The recognition limit was reached. You can still log a meal manually.'
        : 'Suggestions are unavailable. Try again or log a meal manually.');
    },
  });
  const save = useMutation({
    mutationFn: (meal: MealWrite) => session.mutateMeal('POST', '/me/meals', meal, savedMeal.parse),
    onSuccess: async () => {
      setNotice('Meal logged.');
      setReviewed(null);
      setCandidates([]);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['private', owner, 'meals'] }),
        client.invalidateQueries({ queryKey: ['private', owner, 'dashboard'] }),
      ]);
    },
    onError: failure => {
      const status = failureStatus(failure);
      const ambiguous = typeof status !== 'number' || status >= 500;
      setUncertain(ambiguous);
      setError(ambiguous ? 'The save result is uncertain. Retry the same meal to check its receipt.' :
        failure instanceof Error ? failure.message : 'The reviewed meal could not be logged.');
    },
    onSettled: () => { submitting.current = false; },
  });
  const fixtures = capability.data?.data.fixtures ?? [];
  const fixture = fixtures.find(item => item.id === fixtureSelection) ?? fixtures[0];
  const timeZone = preferences.data?.data.timeZone;
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!timeZone || reviewed) return;
    const meal = reviewedMealDraft(candidates, new FormData(event.currentTarget), timeZone, crypto.randomUUID());
    if (!meal.success) {
      setError(candidates.some(item => item.label)
        ? 'Check the name, consumed amount, label numbers and local date and time.'
        : 'Enter a food name, a positive measured portion, and a valid local date and time.');
      return;
    }
    setError('');
    setReviewed(meal.data);
  }
  function confirm() {
    if (!reviewed || submitting.current) return;
    submitting.current = true;
    setError('');
    save.mutate(reviewed);
  }
  function changeLabel(index: number, change: (label: ProductLabel) => ProductLabel) {
    setCandidates(prior => prior.map((item, i) => i === index && item.label ? { ...item, label: change(item.label) } : item));
  }

  return <div className="tempo-card-grid min-w-0">
    <header>
      <h1 className="text-3xl font-semibold">Food recognition</h1>
      <p className="text-muted-foreground">Try an approved sample or capture a product label for local preview. Review all suggestions before logging.</p>
    </header>
    <div className="flex flex-wrap gap-x-4">
      <Link className="inline-flex min-h-11 items-center text-sm text-accent underline" to="/app/meals">Log a meal manually</Link>
      <Link className="inline-flex min-h-11 items-center text-sm text-accent underline" to="/app/foods">Look up a barcode</Link>
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <GlassPanel tone="solid"><div className="space-y-3">
    {capability.isPending && <LoadingSkeleton label="Checking sample recognition availability." shape="form" count={1} />}
    {capability.isError && <p role="alert">Recognition availability could not be checked. <Button variant="outline" onClick={() => void capability.refetch()}>Retry</Button></p>}
    {capability.data?.data.enabled === false && <p>Food recognition is off in this environment.</p>}
    {capability.data?.data.enabled && <form className="space-y-3" onSubmit={event => {
      event.preventDefault();
      if (recognition.isPending || reviewed) return;
      if (!fixture) return;
      setError('');
      setNotice('');
      recognition.mutate(fixture.id);
    }}>
      <ValuePicker label="Sample image" name="fixture" required value={fixture?.id ?? ''} onValueChange={setFixtureSelection}
        disabled={Boolean(reviewed) || recognition.isPending}
        options={capability.data.data.fixtures.map(item => ({ value: item.id, label: item.label }))} />
      {fixture && <img width={160} height={160} className="size-40 rounded-lg border border-border object-contain"
        src={apiBase + path + '/fixtures/' + encodeURIComponent(fixture.id)} alt={fixture.label} />}
      <Button type="submit" disabled={recognition.isPending || Boolean(reviewed) || !capability.data.data.fixtures.length}>
        {recognition.isPending ? 'Analyzing sample…' : 'Analyze sample'}
      </Button>
    </form>}</div></GlassPanel>
    <GlassPanel title="Product photo" tone="solid">
      <ProductPhotoFlow disabled={Boolean(reviewed) || recognition.isPending} onDraft={draft => {
        setError('');
        setNotice('');
        setCandidates([{ ...draft, estimate: null, grams: '' }]);
      }} />
    </GlassPanel>
    {candidates.length > 0 && !reviewed && <GlassPanel tone="solid"><form className="space-y-4" onSubmit={prepare}>
      <h2 className="text-xl font-semibold">Review and edit suggestions</h2>
      <p>{candidates.some(item => item.label) ? 'Review the label values and enter the amount you consumed. Leave unreadable values blank.' :
        'Enter the measured portion for each food you choose to log. Nutrient values will be recorded as unknown.'}</p>
      {candidates.map((item, index) => <fieldset key={index} className="grid gap-2 border-t border-border pt-3">
        <legend className="px-1 font-medium">Food {index + 1}</legend>
        <p className="text-sm text-muted-foreground">{item.label ? (item.labelSource === 'camera' ? 'Source: Your nutrition label photo' : 'Source: Synthetic product label (mock analysis)') :
          item.estimate === null ? 'Suggested portion: Unknown' : 'Estimated portion: ' + item.estimate + ' g'}</p>
        <label className="grid gap-1">Food name<input required className={field} maxLength={200} value={item.name}
          onChange={event => setCandidates(prior => prior.map((candidate, i) => i === index ? { ...candidate, name: event.target.value } : candidate))} /></label>
        {item.label && <>
          <ValuePicker label="Label basis" value={item.label.basis}
            onValueChange={value => changeLabel(index, label => ({ ...label, basis: value === 'per_100g' ? 'per_100g' : 'per_serving' }))}
            options={[{ value: 'per_serving', label: 'Per serving' }, { value: 'per_100g', label: 'Per 100 g' }]} />
          {item.label.basis === 'per_serving' && <label className="grid gap-1">Grams per serving
            <input className={field} inputMode="decimal" value={item.label.grams} placeholder="Unknown"
              aria-describedby={`label-serving-help-${index}`}
              onChange={event => { const grams = event.target.value; changeLabel(index, label => ({ ...label, grams })); }} />
          </label>}
          {item.label.basis === 'per_serving' && <p id={`label-serving-help-${index}`} className="text-sm text-muted-foreground">
            Without the serving weight, consumed nutrition is unknown.
          </p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {(Object.keys(labelNutrients) as (keyof typeof labelNutrients)[]).map(key =>
              <label key={key} className="grid gap-1">{labelNutrients[key]}
                <input className={field} inputMode="decimal" value={item.label?.nutrients[key]} placeholder="Unknown"
                  onChange={event => { const amount = event.target.value; changeLabel(index, label => ({ ...label, nutrients: { ...label.nutrients, [key]: amount } })); }} />
              </label>)}
          </div>
        </>}
        <label className="grid gap-1">Measured portion (g)<input required className={field} inputMode="decimal" value={item.grams}
          onChange={event => setCandidates(prior => prior.map((candidate, i) => i === index ? { ...candidate, grams: event.target.value } : candidate))} /></label>
        <Button type="button" variant="outline" onClick={() => setCandidates(prior => prior.filter((_, i) => i !== index))}>Remove food {index + 1}</Button>
      </fieldset>)}
      <FormValuePicker label="Meal type" name="mealType" defaultValue={mealTypeSchema.options[0]}
        options={mealTypeSchema.options.map(value => ({ value, label: value }))} />
      {timeZone ? <label className="grid gap-1">Date and time ({timeZone})<input required type="datetime-local" name="time" className={field}
        defaultValue={mealWallTime(new Date().toISOString(), timeZone)} /></label> :
        preferences.isPending ? <LoadingSkeleton label="Loading meal date and time." shape="form" count={1} /> :
          <p role="alert">Your time zone is unavailable. Try again from Meals.</p>}
      <Button type="submit" disabled={!timeZone}>Review meal</Button>
    </form></GlassPanel>}
    {reviewed && <GlassPanel title="Confirm reviewed meal" tone="solid"><div className="space-y-3">
      <p>{reviewed.mealType} · {mealWallTime(reviewed.occurredAt, reviewed.timeZone!).replace('T', ' ')} ({reviewed.timeZone})</p>
      <ul className="space-y-2">{reviewed.items.map((item, index) => <li key={index}>
        {'manual' in item ? item.manual.name : ''} · {item.quantity} {item.unit}
      </li>)}</ul>
      {candidates.some(item => item.label) ? <div className="space-y-2 text-sm">
        <p>Source: Synthetic product label (mock analysis)</p>
        {reviewed.items.map((item, index) => 'manual' in item && <div key={index}>
          <p>{item.manual.basis.kind === 'per_100g' ? 'Per 100 g' : `Per serving (${item.manual.basis.grams ?? 'unknown'} g)`}</p>
          <ul>{(Object.keys(labelNutrients) as (keyof typeof labelNutrients)[]).map(key =>
            <li key={key}>{labelNutrients[key]} {item.manual.nutrients[key] ?? 'Unknown'}</li>)}</ul>
        </div>)}
      </div> : <p className="text-sm text-muted-foreground">Nutrient values are unknown.</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={confirm} disabled={save.isPending}>{uncertain ? 'Retry same meal' : 'Confirm and log meal'}</Button>
        <Button type="button" variant="outline" disabled={save.isPending || uncertain} onClick={() => { setReviewed(null); setError(''); }}>Back to editing</Button>
      </div>
    </div></GlassPanel>}
  </div>;
}

export function FoodRecognitionPage({ session }: { session: Session }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return snapshot.status === 'authenticated'
    ? <RecognitionReview key={snapshot.user.id} session={session} owner={snapshot.user.id} /> : null;
}
