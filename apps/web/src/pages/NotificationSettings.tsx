import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { GlassPanel } from '@/components/shared/GlassPanel'
import type { Session } from '@/lib/api/session'

const labels = {
  meal_reminder: 'Daily fitness digest',
  weekly_summary: 'Weekly summary',
  milestone: 'Goal milestones',
  inactivity: 'Inactivity check-in',
  workout_reminder: 'Workout reminders',
  hydration_reminder: 'Hydration reminders',
}
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
const preferences = z.object({
  mode: z.enum(['manual-dry-run', 'hobby-daily']),
  timeZone: z.string(),
  globalOptOut: z.boolean(),
  quietStart: clock.nullable(),
  quietEnd: clock.nullable(),
  revision: z.number().int().nonnegative(),
  types: z.array(z.object({ type: z.enum(labelsKeys()), enabled: z.boolean(), supported: z.boolean() })),
  nextSendAt: z.null(),
})
const response = z.object({ data: preferences })
const endpoint = '/me/notification-preferences'

function labelsKeys() {
  return Object.keys(labels) as (keyof typeof labels)[]
}

type Draft = {
  revision: number
  globalOptOut: boolean
  quietStart: string | null
  quietEnd: string | null
  enabled: Record<string, boolean>
}

function SettingsForm({ value, busy, save }: {
  value: z.infer<typeof preferences>
  busy: boolean
  save: (draft: Draft) => void
}) {
  const [optOut, setOptOut] = useState(value.globalOptOut)
  const [quietError, setQuietError] = useState(false)
  const quietDetails = useRef<HTMLDetailsElement>(null)
  const quietStartInput = useRef<HTMLInputElement>(null)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = new FormData(event.currentTarget)
    const quietStart = String(form.get('quietStart') ?? '') || null
    const quietEnd = String(form.get('quietEnd') ?? '') || null
    if ((quietStart === null) !== (quietEnd === null) || (quietStart !== null && quietStart === quietEnd)) {
      if (quietDetails.current) quietDetails.current.open = true
      setQuietError(true)
      quietStartInput.current?.focus()
      return
    }
    setQuietError(false)
    save({
      revision: value.revision, globalOptOut: optOut, quietStart, quietEnd,
      enabled: Object.fromEntries(value.types.map(row => [row.type, row.supported && form.has(row.type)])),
    })
  }

  return <form className="space-y-5" onSubmit={submit}>
    <fieldset disabled={busy} className="min-w-0 space-y-3">
      <legend className="sr-only">Optional email preferences</legend>
      <label className="flex min-h-11 items-center gap-3 font-medium">
        <input type="checkbox" className="size-5 shrink-0 accent-primary" checked={optOut}
          onChange={event => setOptOut(event.target.checked)} />
        Turn off all optional emails
      </label>
      <p className="text-sm text-muted-foreground">Turning these off cancels queued optional emails. Verification and password-reset emails remain available.</p>
      {optOut && <p className="text-sm text-muted-foreground">Your individual choices are saved for when you turn optional emails back on.</p>}
      <div className="divide-y divide-border border-y border-border">
        {value.types.map(row => <label key={row.type} className="flex min-h-11 items-center justify-between gap-3 py-2">
          <span>
            <span className="block font-medium">{labels[row.type]}</span>
            {!row.supported && <span className="block text-sm text-muted-foreground">Requires a scheduler that runs throughout the day.</span>}
          </span>
          <input type="checkbox" name={row.type} disabled={!row.supported} defaultChecked={row.supported && row.enabled}
            className="size-5 shrink-0 accent-primary" />
        </label>)}
      </div>
      <details ref={quietDetails} className="space-y-3 border-b border-border pb-3">
        <summary className="min-h-11 cursor-pointer content-center font-medium">Quiet hours{value.quietStart && value.quietEnd ? ` · ${value.quietStart}–${value.quietEnd}` : ''}</summary>
        <fieldset className="space-y-3" aria-describedby="notification-quiet-help">
          <legend className="sr-only">Quiet-hour settings</legend>
          <p id="notification-quiet-help" className="text-sm text-muted-foreground">Times use {value.timeZone}. Leave both blank to skip quiet hours.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid min-w-0 gap-1">Start<input ref={quietStartInput} className="tempo-field min-w-0 px-3" type="time" name="quietStart"
              aria-invalid={quietError || undefined} aria-describedby={quietError ? 'notification-quiet-error' : undefined} defaultValue={value.quietStart ?? ''} /></label>
            <label className="grid min-w-0 gap-1">End<input className="tempo-field min-w-0 px-3" type="time" name="quietEnd"
              aria-invalid={quietError || undefined} aria-describedby={quietError ? 'notification-quiet-error' : undefined} defaultValue={value.quietEnd ?? ''} /></label>
          </div>
          {quietError && <p id="notification-quiet-error" role="alert" className="text-sm text-destructive">Enter different start and end times or leave both blank.</p>}
        </fieldset>
      </details>
    </fieldset>
    <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save email settings'}</Button>
  </form>
}

function OwnedSettings({ session, owner }: { session: Session; owner: string }) {
  const cache = useQueryClient()
  const queryKey = ['private', owner, 'notification-preferences']
  const query = useQuery({
    queryKey,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) => session.requestPrivate(endpoint, response.parse, signal),
  })
  const mutation = useMutation({
    mutationFn: (draft: Draft) =>
      session.mutateMeal('PUT', endpoint, draft, response.parse),
    onSuccess: result => {
      const snapshot = session.getSnapshot()
      if (snapshot.status === 'authenticated' && snapshot.user.id === owner) cache.setQueryData(queryKey, result)
    },
  })
  const value = query.data?.data
  const savedStatus = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (mutation.isSuccess && document.activeElement === document.body) savedStatus.current?.focus()
  }, [mutation.isSuccess])
  const conflict = mutation.error && 'status' in mutation.error && mutation.error.status === 409
  return <div className="grid gap-4 md:gap-5">
    <h1 className="text-3xl font-semibold tracking-tight">Email notifications</h1>
    {query.isPending && <GlassPanel tone="solid" title="Optional emails"><LoadingSkeleton label="Loading email settings." shape="form" /></GlassPanel>}
    {query.isError && <GlassPanel tone="solid" title="Optional emails"><div role="alert" className="space-y-3">
      <p>Email settings could not be loaded.</p>
      <Button type="button" variant="outline" onClick={() => void query.refetch()}>Try again</Button>
    </div></GlassPanel>}
    {value && <>
      <GlassPanel title="Delivery availability" className="max-w-2xl">
        <p>{value.mode === 'hobby-daily' ? 'Hobby scheduler · Daily run only' : 'Manual dry run · No scheduled email delivery'}</p>
        <p className="text-sm text-muted-foreground">Scheduled delivery is inactive. No next send is scheduled.</p>
        <Link to="/app/profile" className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">Change time zone in profile settings</Link>
      </GlassPanel>
      <GlassPanel tone="solid" title="Optional emails" className="max-w-2xl">
        <SettingsForm key={value.revision} value={value} busy={mutation.isPending} save={mutation.mutate} />
      </GlassPanel>
    </>}
    {conflict ? <div className="space-y-2" role="alert">
      <p>These settings changed in another session. Reload them before saving.</p>
      <Button type="button" variant="outline" onClick={async () => {
        const result = await query.refetch()
        if (result.isSuccess) mutation.reset()
      }}>Reload email settings</Button>
    </div> : mutation.isError && <p role="alert" className="text-destructive">Email settings could not be saved. Try again.</p>}
    <p ref={savedStatus} role="status" tabIndex={-1} className="text-success">{mutation.isSuccess ? 'Email settings saved.' : ''}</p>
  </div>
}

export function NotificationSettingsPage({ session }: { session: Session }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  if (snapshot.status !== 'authenticated') return null
  return <OwnedSettings key={snapshot.user.id} owner={snapshot.user.id} session={session} />
}
