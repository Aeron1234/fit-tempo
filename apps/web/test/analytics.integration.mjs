import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { aggregateDay, analyticsResponseSchema, dashboardFixtures } from '@fit-tempo/contracts'
import { AnalyticsPage } from '../src/pages/Analytics.tsx'

const timeZone = 'Asia/Manila'
const dates = from => Array.from({ length: 7 }, (_, i) => new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10))
const amount = (knownSubtotal = null, average = null, missingItemCount = 0, knownDays = 0) => ({
  knownSubtotal, average, missingItemCount, knownDays,
})
function week(from) {
  const datesInWeek = dates(from)
  return {
    from, to: datesInWeek[6],
    days: datesInWeek.map(date => ({
      date, nutrition: aggregateDay({ date, timezone: timeZone, status: 'unrecorded', items: [] }), waterMl: null,
    })),
    nutrition: { loggedDays: 0, calories: amount(), protein: amount() },
    hydration: { loggedDays: 0, totalMl: null, averageMl: null },
    workouts: { completedCount: 0, durationSeconds: null, missingDurationCount: 0, overlapCount: 0 },
    activity: { standaloneCount: 0, linkedExcludedCount: 0, durationSeconds: null,
      distanceMeters: null, missingDurationCount: 0, missingDistanceCount: 0 },
    weight: { start: null, end: null, changeKg: null },
  }
}

function fixture() {
  const current = week('2026-11-16')
  current.days[0].nutrition = aggregateDay(dashboardFixtures['2026-11-16'])
  current.days[1].nutrition = aggregateDay(dashboardFixtures['2026-11-17'])
  current.days[2].nutrition = aggregateDay(dashboardFixtures['2026-11-18'])
  current.days[3].nutrition = aggregateDay({ date: '2026-11-19', timezone: timeZone, status: 'partial',
    items: [{ calories: null, protein: null }] })
  current.days[0].waterMl = '500'
  current.days[1].waterMl = '0'
  current.nutrition = { loggedDays: 4, calories: amount('550', '137.5', 1, 3), protein: amount('22.3', '5.575', 2, 3) }
  current.hydration = { loggedDays: 2, totalMl: '500', averageMl: '250' }
  current.workouts = { completedCount: 2, durationSeconds: 600, missingDurationCount: 0, overlapCount: 1 }
  current.activity = { standaloneCount: 1, linkedExcludedCount: 1, durationSeconds: 300,
    distanceMeters: '350', missingDurationCount: 0, missingDistanceCount: 0 }
  current.weight = { start: { date: '2026-11-17', kg: '71.25' }, end: { date: '2026-11-22', kg: '70.5' }, changeKg: '-0.75' }
  return analyticsResponseSchema.parse({ data: { timeZone, current, previous: week('2026-11-09') } })
}

function analyticsHarness() {
  const client = new QueryClient()
  let snapshot = { status: 'authenticated', user: { id: 'owner', role: 'trainee' } }
  const session = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  client.setQueryData(['private', 'owner', 'weekly-analytics', ''], fixture())
  return {
    client, setSnapshot: next => { snapshot = next },
    render: () => renderToStaticMarkup(h(QueryClientProvider, { client }, h(AnalyticsPage, { session }))),
  }
}

test('weekly analytics renders comparable periods, logged-day denominators, gaps and recorded zeroes', () => {
  const { client, render } = analyticsHarness()
  try {
    const html = render()
    assert.match(html, /2026-11-16 to 2026-11-22/)
    assert.match(html, /2026-11-09 to 2026-11-15/)
    assert.match(html, /Asia\/Manila/)
    assert.match(html, /Calories average on 4 logged days<\/dt><dd>137\.5 kcal/)
    assert.match(html, /Protein average on 4 logged days<\/dt><dd>5\.575 g/)
    assert.match(html, /Water average on 2 logged days<\/dt><dd>250 mL/)
    assert.match(html, /2 items missing protein/)
    const rows = html.match(/<time dateTime="[^"]+"[^>]*>[^<]*<\/time>.*?<\/div>/g) ?? []
    assert.match(rows.find(row => row.includes('dateTime="2026-11-17"')) ?? '', />0 kcal/)
    assert.match(rows.find(row => row.includes('dateTime="2026-11-19"')) ?? '', />Unavailable/)
    assert.match(rows.find(row => row.includes('dateTime="2026-11-20"')) ?? '', />Not recorded/)
    assert.match(html, /Linked activities excluded<\/dt><dd>1/)
    assert.match(html, /1 overlapping workouts excluded/)
    assert.match(html, /Measured 71\.25 kg on 2026-11-17 and 70\.5 kg on 2026-11-22/)
    assert.match(html, /Weight change needs comparable measurements/)
  } finally { client.clear() }
})

test('weekly analytics remains scoped across account and session changes', () => {
  const { client, render, setSnapshot } = analyticsHarness()
  try {
    assert.match(render(), /137\.5 kcal/)
    setSnapshot({ status: 'authenticated', user: { id: 'peer', role: 'trainee' } })
    assert.doesNotMatch(render(), /137\.5 kcal|71\.25 kg|2026-11-22/)
    setSnapshot({ status: 'loading' })
    assert.equal(render(), '')
  } finally { client.clear() }
})
