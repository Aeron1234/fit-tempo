import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WorkoutsPage } from '../src/pages/Workouts.tsx'

test('paused workouts render persisted timers, targets and actual sets only for the signed-in owner', () => {
  const client = new QueryClient()
  let auth = { status: 'authenticated', user: { id: 'owner', role: 'trainee' } }
  const session = { getSnapshot: () => auth, subscribe: () => () => {} }
  client.setQueryData(['private', 'owner', 'routines'], { data: [] })
  client.setQueryData(['private', 'owner', 'workout-sessions'], { data: [{
    id: 'paused', revision: 5, status: 'paused', elapsedSeconds: 83, activeSince: null,
    restEndsAt: null, restRemainingSeconds: 17,
    snapshot: { name: 'Fictional circuit', exercises: [{
      exerciseId: 'lift', name: 'Fictional lift',
      targets: [{ setOrder: 1, measurement: { type: 'external_load', reps: 8, loadKg: '10' } },
        { setOrder: 2, measurement: { type: 'external_load', reps: 8, loadKg: '10' } }],
      actualSets: [{ setOrder: 1, measurement: { type: 'external_load', reps: 7, loadKg: '0' } }],
    }] },
    volume: [{ exerciseId: 'lift', name: 'Fictional lift', kgReps: '0' }],
  }] })
  const render = () => renderToStaticMarkup(h(QueryClientProvider, { client }, h(WorkoutsPage, { session })))
  try {
    const html = render()
    assert.match(html, /Fictional circuit.*Paused.*1:23.*Resume workout.*0:17/)
    assert.match(html, /Target 8 reps · 10 kg.*Recorded 7 reps · 0 kg.*No actual set recorded/)
    assert.match(html, /External-load volume by exercise.*0 kg × reps/)
    auth = { status: 'authenticated', user: { id: 'peer', role: 'trainee' } }
    assert.doesNotMatch(render(), /Fictional circuit|Recorded 7 reps/)
  } finally {
    client.clear()
  }
})
