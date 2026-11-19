export const hour = 60 * 60 * 1000

function dateFormatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, calendar: 'iso8601', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit',
  })
}

function dateAt(formatter: Intl.DateTimeFormat, instant: number) {
  const pieces = formatter.formatToParts(instant)
  const part = (kind: Intl.DateTimeFormatPartTypes) => pieces.find(entry => entry.type === kind)?.value
  return `${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}`
}

// Find the first instant on the day in the recorded zone, including zones whose clocks change at midnight.
function boundary(formatter: Intl.DateTimeFormat, utcMidnight: number) {
  const target = new Date(utcMidnight).toISOString().slice(0, 10)
  let low = utcMidnight - 36 * hour
  let high = utcMidnight + 36 * hour
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (dateAt(formatter, middle) < target) low = middle + 1
    else high = middle
  }
  return low
}

export function getDayBounds(date: string, timeZone: string) {
  const formatter = dateFormatter(timeZone)
  const utc = Date.parse(`${date}T00:00:00Z`)
  const tomorrow = new Date(utc)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  return { start: boundary(formatter, utc), end: boundary(formatter, tomorrow.getTime()) }
}

