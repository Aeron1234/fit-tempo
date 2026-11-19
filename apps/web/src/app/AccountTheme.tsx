import { useLayoutEffect, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Session } from '@/lib/api/session'
import { preferencesResponse } from '@/pages/profile-preferences'

export function AccountTheme({ session }: { session: Session }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const owner = snapshot.status === 'authenticated' ? snapshot.user.id : undefined
  const preferences = useQuery({
    queryKey: ['private', owner, 'preferences'],
    enabled: Boolean(owner), retry: false,
    queryFn: ({ signal }) => session.requestPrivate('/me/preferences', preferencesResponse.parse, signal),
  })
  const theme = owner ? preferences.data?.data.theme : undefined
  useLayoutEffect(() => {
    if (theme && theme !== 'system') document.documentElement.dataset.theme = theme
    else delete document.documentElement.dataset.theme
    return () => { delete document.documentElement.dataset.theme }
  }, [theme])
  return null
}
