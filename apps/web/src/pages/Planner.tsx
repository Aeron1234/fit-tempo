import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check } from 'lucide-react';
import { z } from 'zod';
import {
  plannerInputSchema, planConfirmSchema, pantryResponseSchema, recipesResponseSchema, priceCurrencySchema,
  plannerSuggestionsResponseSchema, mealPlansResponseSchema, shoppingListResponseSchema,
  type PlannerInput, type PlannerEstimate, type SavedMealPlan,
} from '@fit-tempo/contracts';
import { Button } from '@/components/ui/button';
import { GlassPanel } from '@/components/shared/GlassPanel';
import { FormValuePicker } from '@/components/shared/FormValuePicker';
import { UnrecordedHatch } from '@/components/shared/UnrecordedHatch';
import type { Session } from '@/lib/api/session';

const field = 'tempo-field';
const label = 'grid min-w-0 gap-1.5 text-sm font-semibold';
const response = z.object({ data: z.unknown() });
type Action = { path: string; body: object };
const money = (currency: string, amount: string | null) => amount === null ? 'Unknown' : `${currency} ${amount}`;

export function PlanEstimate({ estimate }: { estimate: PlannerEstimate }) {
  return <div className="min-w-0 space-y-3">
    <h3 className="text-lg font-semibold">{estimate.recipes.map(recipe => `${recipe.name} (${recipe.servings} servings)`).join(', ')}</h3>
    <dl className="tempo-ledger text-sm">
      <dt>Ingredients used — known subtotal</dt><dd className="tempo-tabular">{money(estimate.currency, estimate.knownConsumedCost)}</dd>
      <dt>Additional quantity used — known subtotal</dt><dd className="tempo-tabular">{money(estimate.currency, estimate.knownAdditionalCost)}</dd>
      <dt>Packages to buy — known subtotal</dt><dd className="tempo-tabular">{money(estimate.currency, estimate.knownCheckoutCost)}</dd>
      <dt>Package checkout budget</dt><dd className="tempo-tabular">{money(estimate.currency, estimate.budgetAmount)}</dd>
      <dt>Within budget (package checkout)</dt><dd className="font-semibold">{estimate.withinBudget === null ? 'Unknown — incomplete coverage' : estimate.withinBudget ? 'Yes' : 'No'}</dd>
    </dl>
    <p className="text-sm text-muted-foreground">These are estimates from your recorded prices. Known subtotals exclude missing values.</p>
    {estimate.missingConsumedPrices.length > 0 && <p className="text-sm text-warning">Missing prices for ingredients used: {estimate.missingConsumedPrices.join(', ')}.</p>}
    {estimate.missingPrices.length > 0 && <p className="text-sm text-warning">Missing ingredient prices: {estimate.missingPrices.join(', ')}.</p>}
    {estimate.missingPackagePrices.length > 0 && <p className="text-sm text-warning">Missing package prices: {estimate.missingPackagePrices.join(', ')}.</p>}
    {estimate.missingQuantities.length > 0 && <p className="text-sm text-warning">Unknown quantities or conversions: {estimate.missingQuantities.join(', ')}.</p>}
    <details className="border-t border-border">
      <summary className="min-h-11 cursor-pointer py-3 font-medium">Ingredient and price breakdown</summary>
      <div className="tempo-scroll" tabIndex={0} role="region" aria-label="Ingredient shortages and costs">
      <table className="tempo-table text-sm">
        <caption className="sr-only">Required ingredients, available amounts, shortages and purchase estimates</caption>
        <thead><tr><th scope="col">Ingredient</th><th scope="col">Required</th><th scope="col">Available</th><th scope="col">Shortage</th><th scope="col">Quantity to buy in packages</th><th scope="col">Checkout cost</th><th scope="col">Leftover quantity</th></tr></thead>
        <tbody>{estimate.items.map((item, index) => <tr key={`${item.foodId}-${index}`}>
          <th scope="row" className="font-medium">{item.foodName}</th>
          <td className="tempo-tabular whitespace-nowrap">{item.quantity} {item.unit}</td>
          <td className="tempo-tabular whitespace-nowrap">{item.availableQuantity} {item.unit}{item.quantityUnknown ? ' (coverage incomplete)' : ''}</td>
          <td className="tempo-tabular whitespace-nowrap">{item.shortageQuantity === null ? 'Unknown' : `${item.shortageQuantity} ${item.unit}`}</td>
          <td className="tempo-tabular whitespace-nowrap">{item.packageQuantity === null ? 'Unknown' : `${item.packageQuantity} ${item.unit}`}</td>
          <td className="tempo-tabular whitespace-nowrap">{money(estimate.currency, item.checkoutCost)}</td>
          <td className="tempo-tabular whitespace-nowrap">{item.leftovers === null ? 'Unknown' : `${item.leftovers} ${item.unit}`}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{estimate.assumptions.map((text, index) => <li key={index}>{text}</li>)}</ul>
    </details>
  </div>;
}

function PrivatePlanner({ session, owner }: { session: Session; owner: string }) {
  const client = useQueryClient();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [input, setInput] = useState<PlannerInput | null>(null);
  const [suggestions, setSuggestions] = useState<PlannerEstimate[] | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [deduction, setDeduction] = useState<SavedMealPlan | null>(null);
  const pantry = useQuery({ queryKey: ['private', owner, 'pantry'], retry: false,
    queryFn: ({ signal }) => session.requestPrivate('/me/pantry', pantryResponseSchema.parse, signal) });
  const recipes = useQuery({ queryKey: ['private', owner, 'recipes'], retry: false,
    queryFn: ({ signal }) => session.requestPrivate('/me/recipes', recipesResponseSchema.parse, signal) });
  const plans = useQuery({ queryKey: ['private', owner, 'meal-plans'], retry: false,
    queryFn: ({ signal }) => session.requestPrivate('/me/meal-plans', mealPlansResponseSchema.parse, signal) });
  const shopping = useQuery({ queryKey: ['private', owner, 'shopping-list'], retry: false,
    queryFn: ({ signal }) => session.requestPrivate('/me/shopping-list', shoppingListResponseSchema.parse, signal) });
  const purchase = useMutation({ retry: false,
    mutationFn: ({ id, purchased }: { id: string; purchased: boolean }) => session.mutateMeal('PATCH', `/me/shopping-list/${id}`, { purchased }, response.parse),
    onSuccess: async () => { setError(''); await client.invalidateQueries({ queryKey: ['private', owner, 'shopping-list'] }); },
    onError: () => { setError('The shopping status could not be confirmed. Reload the list before trying again.'); void shopping.refetch(); },
  });
  const suggest = useMutation({ retry: false,
    mutationFn: (body: PlannerInput) => session.mutateMeal('POST', '/me/meal-plans/suggest', body,
      value => plannerSuggestionsResponseSchema.parse(value).data),
    onSuccess: (data, body) => { setSuggestions(data); setInput(body); setError(''); },
    onError: () => { setSuggestions(null); setError('Suggestions could not be loaded. Refresh pantry data and try again.'); void pantry.refetch(); },
  });
  const write = useMutation({ retry: false,
    mutationFn: (action: Action) => session.mutateMeal('POST', action.path, action.body, response.parse),
    onSuccess: async (_result, action) => {
      setPending(null); setDeduction(null);
      setNotice(action.path.endsWith('/deduct') ? 'Pantry deduction confirmed. Meal history is unchanged.' : 'Plan saved. No pantry stock was reserved or deducted.');
      setError('');
      if (action.path.endsWith('/deduct')) { setSuggestions(null); setInput(null); }
      await Promise.all(['meal-plans', 'shopping-list', 'pantry'].map(key => client.invalidateQueries({ queryKey: ['private', owner, key] })));
    },
    onError: (failure, action) => {
      const status = failure && typeof failure === 'object' && 'status' in failure ? failure.status : undefined;
      if (status === 409) {
        setDeduction(null); setSuggestions(null); setInput(null); setPending(null);
        setError('Your pantry or recipe changed. Review fresh suggestions before saving or deducting.');
        void pantry.refetch(); void plans.refetch();
      } else if (status === undefined || (typeof status === 'number' && status >= 500)) {
        setPending(action); setError('The result is uncertain. Retry the same operation to recover its saved result.');
      } else { setPending(null); setError('The operation could not be confirmed. Review the saved records.'); }
    },
  });
  const busy = write.isPending || suggest.isPending || pending !== null;
  const ingredients = [...new Map(recipes.data?.data.flatMap(recipe => recipe.items).map(item => [item.foodId, item]) ?? []).values()];
  function submit(action: Action) { if (!write.isPending) { setError(''); setNotice(''); write.mutate(action); } }
  return <div className="tempo-card-grid min-w-0">
    <header className="space-y-2"><h1 className="text-3xl font-semibold tracking-tight">Pantry and budget planner</h1>
      <p className="max-w-prose text-muted-foreground">Review deterministic recipe suggestions using your pantry and recorded prices. Viewing, saving, logging a meal and deducting stock are separate actions.</p>
      <Link className="inline-block py-2 font-medium text-accent underline" to="/app/ingredients">Manage recipes, pantry and prices, or log a recipe meal</Link>
    </header>
    {error && <p role="alert" className="flex gap-2 text-sm text-destructive"><AlertCircle className="shrink-0" size={18} aria-hidden="true" />{error}</p>}
    {notice && <p role="status" className="flex gap-2 text-sm text-success"><Check className="shrink-0" size={18} aria-hidden="true" />{notice}</p>}
    {pending && <Button type="button" disabled={write.isPending} onClick={() => submit(pending)}>Retry same operation</Button>}
    {pantry.isPending && <LoadingSkeleton label="Loading pantry availability." shape="ledger" count={1} />}
    {(pantry.isError || recipes.isError) && <div role="alert" className="space-y-2"><p>Pantry or recipe data is unavailable.</p><Button variant="outline" onClick={() => { void pantry.refetch(); void recipes.refetch(); }}>Reload ingredients</Button></div>}
    <GlassPanel tone="solid"><form className="space-y-4" onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const parsed = plannerInputSchema.safeParse({
        budget: { amount: String(data.get('budget')).trim().replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1'), currency: data.get('currency') },
        servings: String(data.get('servings')).trim().replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1'),
        maxPrepMinutes: Number(data.get('minutes')), pantryRevision: pantry.data?.data.revision,
        excludedIngredientIds: data.getAll('excluded'),
      });
      if (!parsed.success) { setError('Enter a nonnegative budget, positive servings and preparation time from 0 to 1440 minutes.'); return; }
      setSuggestions(null); setNotice(''); setError(''); suggest.mutate(parsed.data);
    }}>
      <h2 className="text-xl font-semibold">Find a meal</h2>
      <fieldset disabled={busy || pantry.data === undefined} className="grid gap-4 sm:grid-cols-2">
        <label className={label}>Budget for packages to buy<input name="budget" inputMode="decimal" className={field} defaultValue="100" required /></label>
        <FormValuePicker label="Currency" name="currency" defaultValue={priceCurrencySchema.options[0]}
          options={priceCurrencySchema.options.map(value => ({ value, label: value }))} />
        <label className={label}>Servings per recipe<input name="servings" inputMode="decimal" className={field} defaultValue="1" required /></label>
        <label className={label}>Maximum preparation time (minutes)<input name="minutes" type="number" min="0" max="1440" className={field} defaultValue="30" required /></label>
      </fieldset>
      <fieldset disabled={busy} className="space-y-2"><legend className="text-sm font-semibold">Exclude ingredients (optional)</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1">{ingredients.map(item => <label key={item.foodId} className="flex min-h-11 items-center gap-2 text-sm"><input className="accent-primary" type="checkbox" name="excluded" value={item.foodId} />{item.foodName}</label>)}</div>
        <p className="text-sm text-muted-foreground">Exclusions match recorded ingredients only. Incomplete ingredient labels cannot establish allergen safety.</p>
      </fieldset>
      <Button type="submit" disabled={busy || pantry.data === undefined}>Review suggestions</Button>
    </form></GlassPanel>
    <p role="status" className="sr-only">{suggest.isPending ? 'Finding meal suggestions.' : suggestions === null ? '' :
      suggestions.length === 0 ? 'No matching meal suggestions.' :
        `${suggestions.length} meal ${suggestions.length === 1 ? 'suggestion' : 'suggestions'} ready for review.`}</p>
    {suggest.isPending && <p role="status">Calculating ingredient coverage and package costs.</p>}
    {suggestions && <section className="space-y-5" aria-label="Recipe suggestions"><h2 className="text-2xl font-semibold">Suggestions</h2>
      {suggestions.length === 0 && <div className="space-y-3"><UnrecordedHatch /><p>No recipes fit these constraints. Adjust your filters or add recipes with known preparation times.</p></div>}
      {suggestions.map((estimate, index) => <GlassPanel tone="solid" className="space-y-4" key={index}><PlanEstimate estimate={estimate} />
        <p className="text-sm text-muted-foreground">Saving preserves this estimate and a shopping list. It does not reserve inventory or log a meal.</p>
        <Button disabled={busy} onClick={() => {
          if (!input) return;
          const body = planConfirmSchema.parse({ ...input, expectedEstimateDigest: estimate.estimateDigest,
            recipes: estimate.recipes.map(({ recipeId, recipeRevision }) => ({ recipeId, recipeRevision })), clientOperationId: crypto.randomUUID() });
          submit({ path: '/me/meal-plans/confirm', body });
        }}>Confirm and save plan</Button>
      </GlassPanel>)}
    </section>}
    <GlassPanel title="Saved plans and shopping lists" tone="solid"><div className="space-y-5">
      <p className="text-sm text-muted-foreground">Showing up to 100 most recent saved plans and 100 shopping items. Older shopping items may be outside this view.</p>
      {plans.isPending && <LoadingSkeleton label="Loading saved plans." shape="rows" />}
      {plans.isError && <div role="alert"><p>Saved plans are unavailable.</p><Button variant="outline" onClick={() => void plans.refetch()}>Reload saved plans</Button></div>}
      {plans.data?.data.length === 0 && <p>No plans saved yet. Review a suggestion first.</p>}
      {plans.data?.data.map(plan => <article key={plan.id} className="space-y-4 border-t border-border pt-4"><PlanEstimate estimate={plan.estimate} />
        <p className="text-sm text-muted-foreground">Saved estimate · {plan.createdAt.slice(0, 10)} · Pantry revision {plan.estimate.pantryRevision}</p>
        <h3 className="font-semibold">Shopping checklist</h3>
        <p className="text-sm text-muted-foreground">Marking a purchase changes this checklist only. Add purchased stock through Pantry separately.</p>
        {shopping.isPending && <LoadingSkeleton label="Loading shopping checklist." shape="ledger" />}
        {shopping.isError && <div role="alert"><p>Shopping checklist is unavailable.</p><Button variant="outline" onClick={() => void shopping.refetch()}>Reload shopping checklist</Button></div>}
        {shopping.data && !shopping.data.data.some(item => item.mealPlanId === plan.id) && <p className="text-sm">No shopping items for this plan in the current view. Review the saved shortage estimate above.</p>}
        {shopping.data?.data.filter(item => item.mealPlanId === plan.id).map(item => <label key={item.id} className="flex min-h-11 items-center gap-3 text-sm">
          <input className="accent-primary" type="checkbox" checked={item.purchased} disabled={purchase.isPending || busy} onChange={event => purchase.mutate({ id: item.id, purchased: event.target.checked })} />
          <span>{item.foodName} — {item.shortageQuantity === null ? 'Quantity unknown' : `${item.shortageQuantity} ${item.unit}`} {item.purchased ? '(purchased)' : '(to buy)'}</span>
        </label>)}
        {plan.deducted ? <p className="flex items-center gap-2 text-success"><Check size={18} aria-hidden="true" />Pantry deduction recorded</p>
          : <><Button variant="outline" disabled={busy || plan.estimate.missingQuantities.length > 0} onClick={() => setDeduction(plan)}>Review pantry deduction</Button>
            {plan.estimate.missingQuantities.length > 0 && <p className="text-sm text-warning">Resolve unknown quantities and save a fresh plan before deducting pantry stock.</p>}</>}
        {deduction?.id === plan.id && <div className="space-y-3 border-t border-border pt-3" role="region" aria-label="Confirm pantry deduction">
          <h3 className="font-semibold">Deduct the allocated pantry quantities?</h3>
          <p className="text-sm">Only pantry stock allocated in this saved estimate will be deducted. Shortages must be bought separately. This action does not log a meal. A changed pantry requires a fresh plan.</p>
          {plan.estimate.allocations.length === 0 ? <p>No pantry quantities were allocated.</p> : <ul className="space-y-2">{plan.estimate.allocations.map(allocation => <li key={allocation.lotId} className="tempo-ledger text-sm">
            <span className="min-w-0 break-words">{allocation.foodName}<span className="block break-all text-muted-foreground">Lot {allocation.lotId} · Expiry {allocation.expiresOn ?? 'unknown'}</span></span>
            <span className="tempo-tabular whitespace-nowrap">{allocation.quantity} {allocation.unit}</span>
          </li>)}</ul>}
          <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => submit({ path: `/me/meal-plans/${plan.id}/deduct`, body: { expectedPantryRevision: plan.estimate.pantryRevision, clientOperationId: crypto.randomUUID() } })}>Confirm pantry deduction</Button>
            <Button variant="outline" disabled={busy} onClick={() => setDeduction(null)}>Cancel</Button></div>
        </div>}
      </article>)}
    </div></GlassPanel>
  </div>;
}

export function PlannerPage({ session }: { session: Session }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return snapshot.status === 'authenticated' ? <PrivatePlanner key={snapshot.user.id} session={session} owner={snapshot.user.id} /> : null;
}
