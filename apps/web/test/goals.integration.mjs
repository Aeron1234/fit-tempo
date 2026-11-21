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
