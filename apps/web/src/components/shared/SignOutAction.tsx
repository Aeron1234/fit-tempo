import { LogOut } from 'lucide-react';

export function SignOutAction({ variant, busy, onSignOut }: {
  variant: 'rail' | 'sheet'; busy: boolean; onSignOut: () => void;
}) {
  const rail = variant === 'rail';
  return (
    <button type="button" aria-label="Sign out" title={rail ? 'Sign out' : undefined}
      className={rail
        ? 'tempo-sign-out flex min-h-12 w-full items-center justify-center gap-3 rounded-lg px-1 py-1 text-sm lg:justify-start lg:px-4'
        : 'flex min-h-12 w-full items-center gap-3 rounded-lg px-2 text-foreground hover:bg-muted'}
      disabled={busy} onClick={onSignOut}>
      <LogOut aria-hidden="true" size={rail ? 19 : 20} className="shrink-0" />
      <span className={rail ? 'sr-only lg:not-sr-only' : undefined}>{busy ? 'Signing out.' : 'Sign out'}</span>
    </button>
  );
}
