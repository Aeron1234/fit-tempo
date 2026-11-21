import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { PlanEstimate, PlannerPage } from '../src/pages/Planner.tsx'

const estimate = {
  estimateDigest: 'a'.repeat(64),
  recipeDetails: [],
  recipes: [{ recipeId: 'recipe', recipeRevision: 1, name: 'Fictional rice bowl', servings: '1' }],
  pantryRevision: 3, currency: 'PHP', budgetAmount: '100', missingConsumedPrices: ['Rice'], knownConsumedCost: '0', knownAdditionalCost: '0',
  knownCheckoutCost: '0', missingPrices: ['Rice'], missingQuantities: ['Rice'], missingPackagePrices: ['Rice'],
  withinBudget: null, budgetBasis: 'package_checkout', allocations: [], assumptions: ['No volume-to-mass conversion inferred.'],
  items: [{ foodId: 'food', foodName: 'Rice', quantity: '1', unit: 'cup', availableQuantity: '0',
    shortageQuantity: null, quantityUnknown: true, consumedCost: null, additionalCost: null, checkoutCost: null,
    packageQuantity: null, leftovers: null }],
}

test('planner estimate distinguishes unknown quantities and checkout coverage from recorded zero subtotals', () => {
  const html = renderToStaticMarkup(h(PlanEstimate, { estimate }))
  assert.match(html, /Ingredients used/)
  assert.match(html, /Packages to buy/)
  assert.match(html, /PHP 0/)
  assert.match(html, /PHP 100/)
  assert.match(html, /Unknown — incomplete coverage/)
  assert.match(html, /Missing ingredient prices: Rice/)
  assert.match(html, /Missing package prices: Rice/)
  assert.match(html, /Unknown quantities or conversions: Rice/)
  assert.match(html, /coverage incomplete/)
  assert.doesNotMatch(html, /Within budget[^<]*Yes/)
  assert.match(html, /scope="col"/)
})

test('saved planner output stays private to the active account and separates stock and meal actions', () => {
  const client = new QueryClient()
  let snapshot = { status: 'authenticated', user: { id: 'owner', role: 'trainee' } }
  const session = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  client.setQueryData(['private', 'owner', 'meal-plans'], { data: [{ id: 'plan', estimate, deducted: false, createdAt: '2026-11-20T00:00:00Z' }] })
  client.setQueryData(['private', 'owner', 'pantry'], { data: { revision: 3, items: [] } })
  client.setQueryData(['private', 'owner', 'recipes'], { data: [] })
  const render = () => renderToStaticMarkup(h(QueryClientProvider, { client }, h(MemoryRouter, null, h(PlannerPage, { session }))))
  try {
    const html = render()
    assert.match(html, /Fictional rice bowl/)
    assert.match(html, /Viewing, saving, logging a meal and deducting stock are separate actions/)
    assert.match(html, /Review pantry deduction/)
    assert.doesNotMatch(html, /Confirm pantry deduction/)
    assert.match(html, /href="\/app\/ingredients"/)
    snapshot = { status: 'authenticated', user: { id: 'other', role: 'trainee' } }
    assert.doesNotMatch(render(), /Fictional rice bowl/)
    snapshot = { status: 'checking' }
    assert.equal(render(), '')
  } finally { client.clear() }
})
