import assert from 'node:assert/strict'
import test from 'node:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { hydrationGoalsResponseSchema, waterResponseSchema } from '@fit-tempo/contracts'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GoalsPage } from '../src/pages/Goals.tsx'

const waterDay = { date: '2026-11-20', timeZone: 'Asia/Manila', entries: [] }
const goalId = 'fdc20aa5-dc65-4059-8a90-54f650e1f8e6'

test('goals distinguish an unrecorded water day from a known zero', () => {
  const client = new QueryClient()
  const snapshot = { status: 'authenticated', user: { id: 'owner', role: 'trainee' } }
  const session = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  function render(totalMl) {
    client.setQueryData(['private', 'owner', 'water', ''], waterResponseSchema.parse({ data: { ...waterDay, totalMl } }))
    return renderToStaticMarkup(h(QueryClientProvider, { client }, h(GoalsPage, { session })))
  }
  try {
    assert.match(render(null), /Not recorded · Asia\/Manila/)
    assert.match(render('0'), /0 mL · Asia\/Manila/)
  } finally {
    client.clear()
  }
})

test('hydration milestones and scheduled workout streak stay scoped to the signed-in account', () => {
  const client = new QueryClient()
  let snapshot = { status: 'authenticated', user: { id: 'owner', role: 'trainee' } }
  const session = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  client.setQueryData(['private', 'owner', 'water', ''], waterResponseSchema.parse({ data: { ...waterDay, totalMl: '875' } }))
  client.setQueryData(['private', 'owner', 'goals'], hydrationGoalsResponseSchema.parse({ data: {
    goals: [{ id: goalId, targetMl: '750', effectiveFrom: waterDay.date, effectiveUntil: null, status: 'active' }],
    milestones: [{ id: 'c1cc241c-afd4-4eba-aab6-9e9429d73e31', goalId, occurredAt: '2026-11-20T03:30:00.000Z' }],
    workoutStreak: 2,
  } }))
  const render = () => renderToStaticMarkup(h(QueryClientProvider, { client }, h(GoalsPage, { session })))
  try {
    const html = render()
    assert.match(html, /875 mL/)
    assert.match(html, /750 mL/)
    assert.match(html, /Completed workout streak: 2/)
    assert.match(html, /Rest days do not break it/)
    assert.match(html, /Hydration target crossed/)
    assert.match(html, /2026-11-20 11:30 \(Asia\/Manila\)/)
    snapshot = { status: 'authenticated', user: { id: 'peer', role: 'trainee' } }
    assert.doesNotMatch(render(), /875 mL|750 mL|Hydration target crossed|Completed workout streak/)
    snapshot = { status: 'loading' }
    assert.equal(render(), '')
  } finally {
    client.clear()
  }
})

test('nutrition targets keep nutrient coverage, recorded zero and an unrecorded day distinct', () => {
  const client = new QueryClient()
  let snapshot = { status: 'authenticated', user: { id: 'owner', role: 'trainee' } }
  const session = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  const saved = { energyKcal: 1800, proteinG: 100, carbsG: 240, fatG: 60,
    effectiveFrom: waterDay.date, savedAt: '2026-11-20T01:00:00.000Z' }
  const latestWeight = { weightKg: '75', localDate: waterDay.date, measuredAt: '2026-11-20T02:00:00.000Z' }
  const targetsKey = ['private', 'owner', 'nutrition-targets']
  const progressKey = ['private', 'owner', 'dashboard', '']
  const coverage = (unit, knownSubtotal, missingItemCount = 0) => ({ unit, knownSubtotal, missingItemCount })
  const render = () => renderToStaticMarkup(h(QueryClientProvider, { client }, h(GoalsPage, { session })))
  const seed = (status, values) => client.setQueryData(progressKey, { data: {
    date: waterDay.date, timezone: waterDay.timeZone, status, itemCount: status === 'partial' ? 2 : 0,
    calories: coverage('kcal', values[0]), protein: coverage('g', values[1], status === 'partial' ? 1 : 0),
    carbs: coverage('g', values[2], status === 'partial' ? 2 : 0), fat: coverage('g', values[3]),
  }, meta: { mode: 'local', fixtureDates: [] } })
  try {
    client.setQueryData(targetsKey, { data: { revision: 0, targets: null } })
    assert.match(render(), /Enter targets manually/)
    assert.match(render(), /Estimate my targets/)
    client.setQueryData(targetsKey, { data: { revision: 1, targets: saved, latestWeight } })
    seed('unrecorded', [null, null, null, null])
    assert.match(render(), /Not recorded . 100 g target/)
    seed('complete', ['0', '0', '0', '0'])
    assert.match(render(), /0 of 100 g logged/)
    seed('partial', ['952', '72', null, '0'])
    const html = render()
    assert.match(html, /72 of 100 g logged/)
    assert.match(html, /Incomplete . 1 item missing this value/)
    assert.match(html, /Logged amount unknown . 240 g target/)
    assert.match(html, /Incomplete . 2 items missing this value/)
    assert.match(html, /0 of 60 g logged/)
    assert.match(html, /A newer weight was logged/)
    assert.match(html, /Recalculate from measurements/)
    client.setQueryData(targetsKey, { data: { revision: 2, targets: saved,
      localDate: waterDay.date, dayTargets: { ...saved, proteinG: 95, effectiveFrom: '2026-11-19' } } })
    assert.match(render(), /72 of 95 g logged/)
    client.setQueryData(targetsKey, { data: { revision: 2, targets: saved, localDate: '2026-11-21', dayTargets: saved } })
    assert.doesNotMatch(render(), /72 of 100 g logged/)
    snapshot = { status: 'authenticated', user: { id: 'peer', role: 'trainee' } }
    assert.doesNotMatch(render(), /100 g daily target|A newer weight was logged/)
  } finally {
    client.clear()
  }
})
