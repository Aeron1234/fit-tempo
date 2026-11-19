import assert from 'node:assert/strict'
import test from 'node:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { aggregateDay, dashboardFixtures, syntheticDashboardDates } from '@fit-tempo/contracts'
import { DashboardPage } from '../src/pages/Phase09.tsx'

test('dashboard visibly distinguishes unavailable, confirmed zero, and known protein coverage', () => {
  const snapshot = { status: 'authenticated', user: { id: 'owner', role: 'trainee' } }
  const session = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  const client = new QueryClient()
  function render(date) {
    client.setQueryData(['private', 'owner', 'dashboard', ''], {
      data: aggregateDay(dashboardFixtures[date]),
      meta: { mode: 'synthetic-demo', fixtureDates: syntheticDashboardDates },
    })
    return renderToString(h(QueryClientProvider, { client },
      h(MemoryRouter, null, h(DashboardPage, { session })),
    )).replace(/<!--.*?-->/g, '')
  }
  try {
    assert.match(render('2026-11-15'), /Unavailable/)
    assert.match(render('2026-11-16'), /Some items recorded/)
    assert.match(render('2026-11-17'), /Confirmed zero intake/)
    const completed = render('2026-11-18')
    assert.match(completed, /Nutrition marked complete/)
    assert.match(completed, /14\.2 g/)
    assert.match(completed, /1 item is missing/)
    assert.match(completed, /400 kcal/)
    assert.match(completed, /Asia\/Manila/)
  } finally {
    client.clear()
  }
})

test('dashboard Day strip uses owner-scoped meal records without inventing calories', () => {
  const snapshot = { status: 'authenticated', user: { id: 'owner', role: 'trainee' } }
  const session = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  const client = new QueryClient()
  try {
    client.setQueryData(['private', 'owner', 'dashboard', ''], {
      data: aggregateDay(dashboardFixtures['2026-11-16']), meta: { mode: 'local', fixtureDates: [] },
    })
    client.setQueryData(['private', 'owner', 'meals', '2026-11-16', undefined], { data: { meals: [{
      id: 'meal', occurredAt: '2026-11-16T04:00:00.000Z', mealType: 'lunch',
      totals: { energyKcal: null }, missingNutrients: ['energyKcal'],
    }], nextCursor: null } })
    const result = renderToString(h(QueryClientProvider, { client },
      h(MemoryRouter, null, h(DashboardPage, { session })),
    ))
    assert.match(result, /aria-label="Day strip events"/)
    assert.match(result, /Lunch, Calories unavailable/)
  } finally {
    client.clear()
  }
})
