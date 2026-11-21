import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ExercisesPage } from '../src/pages/Exercises.tsx'

test('exercise and routine rendering preserves ordered units, curated variants and private cache scope', () => {
  const client = new QueryClient()
  let snapshot = { status: 'authenticated', user: { id: 'owner', role: 'trainee' } }
  const session = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  client.setQueryData(['private', 'owner', 'exercises'], { data: [
    { id: 'load', name: 'Fictional lift', equipment: 'Dumbbells', measurementType: 'externalLoad', editable: true },
  ] })
  const load = { exerciseId: 'load', exerciseName: 'Fictional lift', measurementType: 'externalLoad',
    equipment: 'Dumbbells', targetSets: 2, targetReps: 3, targetLoadKg: '0', targetSeconds: null, targetMeters: null, restSeconds: 0 }
  const timed = { ...load, exerciseId: 'timed', exerciseName: 'Fictional hold', measurementType: 'timed',
    equipment: null, targetReps: null, targetLoadKg: null, targetSeconds: '20', restSeconds: null }
  client.setQueryData(['private', 'owner', 'routines'], { data: [{
    id: 'routine', name: 'Fictional routine', durationMinutes: 25, level: 'beginner', editable: true,
    exercises: [load, timed], shorterVariants: [{ id: 'variant', name: 'Quick review', durationMinutes: 10, exercises: [timed] }],
  }] })
  const render = () => renderToStaticMarkup(h(QueryClientProvider, { client }, h(ExercisesPage, { session })))
  try {
    const html = render()
    assert.match(html, /External load \(kg and reps\) · Dumbbells · 2 sets · 3 reps · 0 kg · 0 seconds rest/)
    assert.match(html, /Fictional routine.*Fictional lift.*Fictional hold.*Reviewed shorter variant · Quick review · 10 minutes/)
    assert.match(html, /Timed \(seconds\) · 2 sets · 20 seconds/)
    snapshot = { status: 'authenticated', user: { id: 'peer', role: 'trainee' } }
    assert.doesNotMatch(render(), /Fictional routine|Dumbbells/)
  } finally {
    client.clear()
  }
})
