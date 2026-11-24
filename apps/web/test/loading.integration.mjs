import assert from 'node:assert/strict'
import test from 'node:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LazyRouteSkeleton } from '../src/components/shared/LoadingSkeleton.tsx'
import { NutritionTargets } from '../src/pages/NutritionTargets.tsx'

test('lazy route placeholders reserve chart height without exposing decorative shapes', () => {
  for (const activity of [false, true]) {
    const html = renderToStaticMarkup(h(LazyRouteSkeleton, { activity }))
    assert.match(html, activity ? /Activity and progress/ : /Weekly analytics/)
    assert.match(html, /aria-busy="true"/)
    assert.match(html, /aria-hidden="true"/)
    assert.match(html, /motion-safe:animate-pulse/)
    assert.match(html, /h-56/)
    assert.doesNotMatch(html, /<svg|<canvas/)
  }
})

test('nutrition targets show placeholders only without data and distinguish error and empty', async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  const queryKey = ['private', 'owner', 'nutrition-targets']
  const session = { requestPrivate() { throw new Error('Unexpected request from static render') } }
  const render = (owner = 'owner') => renderToStaticMarkup(h(QueryClientProvider, { client: cache },
    h(NutritionTargets, { session, owner })))
  try {
    let resolve
    const request = cache.fetchQuery({ queryKey, queryFn: () => new Promise(done => { resolve = done }) })
    assert.match(render(), /Loading nutrition targets\./)
    resolve({ data: { revision: 0, targets: null } })
    await request
    assert.match(render(), /Enter targets manually/)
    assert.doesNotMatch(render(), /data-slot="skeleton"/)

    const targets = { energyKcal: 1800, proteinG: 100, carbsG: 200, fatG: 60, effectiveFrom: '2026-11-25' }
    cache.setQueryData(queryKey, { data: { revision: 1, targets } })
    const refresh = cache.fetchQuery({ queryKey, queryFn: () => new Promise(done => { resolve = done }) })
    assert.match(render(), /1800 kcal daily target/)
    assert.doesNotMatch(render(), /Loading nutrition targets\./)
    assert.doesNotMatch(render('other'), /1800 kcal daily target/)
    resolve({ data: { revision: 1, targets } })
    await refresh

    cache.removeQueries({ queryKey })
    await assert.rejects(cache.fetchQuery({ queryKey, queryFn: () => Promise.reject(new Error('offline')) }))
    assert.match(render(), /Could not load nutrition targets/)
    assert.match(render(), /Try again/)
    assert.doesNotMatch(render(), /data-slot="skeleton"/)
  } finally {
    cache.clear()
  }
})
