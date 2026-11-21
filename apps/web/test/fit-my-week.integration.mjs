import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { FitMyWeekPage, ProposalDetails } from '../src/pages/FitMyWeek.tsx'

const fixture = {
  id: 'synthetic-workout', routineId: 'routine', variantId: null, name: 'Fictional workout',
  startsAt: '2026-11-17T10:00:00.000Z', endsAt: '2026-11-17T10:30:00.000Z',
  timeZone: 'Asia/Manila', localDate: '2026-11-17', status: 'missed',
}

test('a proposal renders the original and shorter local slots before explicit confirmation', () => {
  const html = renderToStaticMarkup(h(ProposalDetails, { busy: false, submit() {}, close() {}, proposal: {
    id: 'proposal', revision: 2, before: fixture,
    after: { ...fixture, name: 'Fictional shorter variant', startsAt: '2026-11-18T10:00:00.000Z',
      endsAt: '2026-11-18T10:20:00.000Z', localDate: '2026-11-18', status: 'planned' },
    beforeExercises: ['3 sets of rows'], afterExercises: ['2 sets of rows'],
  } }))
  assert.match(html, /Before.*2026-11-17 18:00.*30 min.*3 sets of rows/)
  assert.match(html, /After.*Fictional shorter variant.*2026-11-18 18:00.*20 min.*2 sets of rows/)
  assert.match(html, /Confirm reschedule.*Discard preview/)
})

test('the calendar exposes missed-workout actions only in the owning account cache', () => {
  const client = new QueryClient()
  let auth = { status: 'authenticated', user: { id: 'owner', role: 'trainee' } }
  const session = { getSnapshot: () => auth, subscribe: () => () => {} }
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const occurrence = { ...fixture, timeZone: 'UTC', localDate: today,
    startsAt: today + 'T10:00:00.000Z', endsAt: today + 'T10:30:00.000Z' }
  client.setQueryData(['private', 'owner', 'routines'], { data: [] })
  client.setQueryData(['private', 'owner', 'availability'], { data: { revision: 2, timeZone: 'UTC', slots: [], restDays: [0] } })
  client.setQueryData(['private', 'owner', 'scheduled-workouts'], { data: { revision: 2, timeZone: 'UTC', workouts: [occurrence] } })
  const render = () => renderToStaticMarkup(h(QueryClientProvider, { client }, h(MemoryRouter, {}, h(FitMyWeekPage, { session }))))
  try {
    assert.match(render(), /Fictional workout.*Missed.*Find a new slot.*Skip workout/)
    assert.match(render(), /Rest day/)
    auth = { status: 'authenticated', user: { id: 'peer', role: 'trainee' } }
    assert.doesNotMatch(render(), /Fictional workout|Find a new slot/)
  } finally {
    client.clear()
  }
})
