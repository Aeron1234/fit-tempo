import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { DayStrip } from '../src/components/shared/DayStrip.tsx'
import { getDayBounds } from '../src/components/shared/day-strip-time.ts'

test('local Day strip respects DST day length and repeats the correct local hour', () => {
  const timezone = 'America/New_York'
  const spring = getDayBounds('2026-03-08', timezone)
  const autumn = getDayBounds('2026-11-01', timezone)
  assert.equal((spring.end - spring.start) / 3_600_000, 23)
  assert.equal((autumn.end - autumn.start) / 3_600_000, 25)
  const view = renderToString(h(DayStrip, {
    date: '2026-11-01', timeZone: timezone, state: 'partial',
    events: [
      { id: 'a', occurredAt: '2026-11-01T05:30:00Z', kind: 'meal', name: 'Breakfast' },
      { id: 'b', occurredAt: '2026-11-01T06:30:00Z', kind: 'meal', name: 'Snack' },
    ],
  }))
  assert.match(view, /GMT-4/)
  assert.match(view, /GMT-5/)
  assert.match(view, /Not recorded between marks/)
  assert.match(view, /aria-label="Day strip events"/)
  assert.equal((view.match(/<button /g) ?? []).length, 2)
  assert.doesNotMatch(view, /day-strip-now/)
})
