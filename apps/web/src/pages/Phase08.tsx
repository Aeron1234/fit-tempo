import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert, CircleCheck, LayoutDashboard, List, LogOut, NotebookPen, Settings, Utensils } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { DayStrip, type DayEvent } from "@/components/shared/DayStrip";
import type { Session } from "@/lib/api/session";

type SessionProps = { session: Session };
const inputClass = "tempo-field";

function Brand() {
  return <span className="tempo-wordmark text-xl font-bold tracking-tight">Fit Tempo</span>;
}

const sampleEvents = [
  { id: "sample-breakfast", occurredAt: "2026-11-19T00:00:00Z", kind: "meal", name: "Oats and berries", amount: "1 bowl" },
  { id: "sample-lunch", occurredAt: "2026-11-19T04:35:00Z", kind: "meal", name: "Rice and vegetables", amount: "1 plate" },
  { id: "sample-dinner", occurredAt: "2026-11-19T11:15:00Z", kind: "meal", name: "Soup and toast", amount: "1 serving" },
] satisfies DayEvent[];

function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto grid min-h-svh max-w-7xl content-start gap-10 px-5 py-8 sm:px-8 lg:content-center lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16 lg:py-16">
      <div className="min-w-0 space-y-5">
        <Brand />
        <section className="tempo-form space-y-5">
          <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
          {children}
        </section>
      </div>
      <aside className="min-w-0 space-y-8 border-t border-border pt-8 lg:border-t-0 lg:pt-12">
        <p className="tempo-wordmark max-w-[14ch] text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl xl:text-6xl">Your meals. Your movement. Your rhythm.</p>
        <DayStrip date="2026-11-19" timeZone="Asia/Manila" events={sampleEvents} sample />
      </aside>
    </main>
  );
}

function AuthLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="font-medium text-accent underline underline-offset-4" to={to}>
      {children}
    </Link>
  );
}

const forms = {
  signIn: { title: "Sign in", button: "Sign in", email: true, password: true },
  register: { title: "Create your account", button: "Create account", email: true, password: true },
  forgot: { title: "Reset your password", button: "Send reset link", email: true, password: false },
  resend: { title: "Resend verification", button: "Send verification link", email: true, password: false },
  reset: { title: "Choose a new password", button: "Update password", email: false, password: true },
} as const;

type Mode = keyof typeof forms;
type FormValues = { email: string; password: string };

function AccountForm({ session, mode, token }: SessionProps & { mode: Mode; token?: string }) {
  const config = forms[mode];
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => {
    if (mode === "signIn" && session.getSnapshot().status === "checking") void session.initialize();
  }, [mode, session]);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");
  const schema = z.object({
    email: config.email
      ? z.string().trim().max(320).pipe(z.email("Enter a valid email address."))
      : z.string(),
    password: config.password
      ? z.string().min(12, "Use at least 12 characters.").max(256, "Use no more than 256 characters.")
      : z.string(),
  });
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } =
    useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });

  if (mode === "signIn" && snapshot.status === "authenticated") return <Navigate to="/app" replace />;

  const submit = handleSubmit(async ({ email, password }) => {
    setMessage("");
    try {
      switch (mode) {
        case "signIn":
          await session.signIn(email, password);
          break;
        case "register":
          await session.register(email, password);
          setMessage("Check your email for a verification link.");
          break;
        case "forgot":
          await session.requestPasswordReset(email);
          setMessage("If the account is eligible, a reset link will arrive by email.");
          break;
        case "resend":
          await session.resendVerification(email);
          setMessage("If the account needs verification, a link will arrive by email.");
          break;
        case "reset":
          if (!token) return;
          await session.resetPassword(token, password);
          setMessage("Password updated. You can now sign in.");
          break;
      }
      reset();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The request could not be completed. Try again.");
    }
  });

  return (
    <AuthFrame title={config.title}>
      <form className="space-y-4" noValidate onSubmit={(event) => {
        setFailure("");
        void submit(event);
      }}>
        {config.email && (
          <div className="space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="account-email">Email address</label>
            <input id="account-email" type="email" autoComplete="email" className={inputClass}
              aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? "account-email-error" : undefined}
              {...register("email")} />
            {errors.email && <p id="account-email-error" className="flex items-start gap-2 text-sm text-destructive"><CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{errors.email.message}</p>}
          </div>
        )}
        {config.password && (
          <div className="space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="account-password">
              {mode === "reset" ? "New password" : "Password"}
            </label>
            <input id="account-password" type="password" className={inputClass}
              autoComplete={mode === "signIn" ? "current-password" : "new-password"}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? "account-password-error" : undefined} {...register("password")} />
            {errors.password && (
              <p id="account-password-error" className="flex items-start gap-2 text-sm text-destructive"><CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{errors.password.message}</p>
            )}
          </div>
        )}
        {failure && <p role="alert" className="flex items-start gap-2 text-sm text-destructive"><CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{failure}</p>}
        {message && <p role="status" className="flex items-start gap-2 text-sm text-success"><CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{message}</p>}
        <Button type="submit" className="w-full" disabled={isSubmitting || (mode === "signIn" && snapshot.status === "checking") || (mode === "reset" && Boolean(message))}>
          {isSubmitting ? "Please wait…" : config.button}
        </Button>
      </form>
      <div className="mt-6 flex flex-wrap gap-x-4 gap-y-2 text-sm">
        {mode === "signIn" ? (
          <>
            <AuthLink to="/register">Create account</AuthLink>
            <AuthLink to="/forgot-password">Forgot password?</AuthLink>
            <AuthLink to="/resend-verification">Resend verification</AuthLink>
          </>
        ) : <AuthLink to="/sign-in">Go to sign in</AuthLink>}
      </div>
    </AuthFrame>
  );
}

export const SignInPage = (props: SessionProps) => <AccountForm {...props} mode="signIn" />;
export const RegisterPage = (props: SessionProps) => <AccountForm {...props} mode="register" />;
export const ForgotPasswordPage = (props: SessionProps) => <AccountForm {...props} mode="forgot" />;
export const ResendVerificationPage = (props: SessionProps) => <AccountForm {...props} mode="resend" />;

const emailToken = z.string().min(32).max(256);

function useEmailToken() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => {
    const value = emailToken.safeParse(new URLSearchParams(search).get("token"));
    return value.success ? value.data : undefined;
  });
  useEffect(() => {
    if (new URLSearchParams(search).has("token")) void navigate(pathname, { replace: true });
  }, [navigate, pathname, search]);
  return token;
}

export function VerifyEmailPage({ session }: SessionProps) {
  const token = useEmailToken();
  const [state, setState] = useState<"idle" | "working" | "verified">("idle");
  const [error, setError] = useState("");
  return (
    <AuthFrame title="Verify your email">
      {!token && <p className="mb-4 text-sm text-muted-foreground">Open the verification link from your email.</p>}
      {state === "verified" && <p role="status" className="mb-4 flex items-start gap-2 text-sm text-success"><CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />Email verified. You can now sign in.</p>}
      {error && <p role="alert" className="mb-4 flex items-start gap-2 text-sm text-destructive"><CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{error}</p>}
      {token && state !== "verified" && (
        <Button type="button" disabled={state === "working"} onClick={() => {
          setError("");
          setState("working");
          void session.verifyEmail(token).then(() => setState("verified"), (reason: unknown) => {
            setState("idle");
            setError(reason instanceof Error ? reason.message : "Verification failed. Try requesting a new link.");
          });
        }}>{state === "working" ? "Verifying…" : "Verify email"}</Button>
      )}
      <div className="mt-6 flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <AuthLink to="/sign-in">Go to sign in</AuthLink>
        <AuthLink to="/resend-verification">Request a new link</AuthLink>
      </div>
    </AuthFrame>
  );
}

export function ResetPasswordPage({ session }: SessionProps) {
  const token = useEmailToken();
  if (token) return <AccountForm session={session} mode="reset" token={token} />;
  return (
    <AuthFrame title="Reset your password">
      <p className="mb-4 text-sm text-muted-foreground">Open the reset link from your email.</p>
      <AuthLink to="/forgot-password">Request a new link</AuthLink>
    </AuthFrame>
  );
}

export function ProtectedLayout({ session }: SessionProps) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [signingOut, setSigningOut] = useState(false);
  const [failure, setFailure] = useState("");
  useEffect(() => { void session.initialize(); }, [session]);

  if (snapshot.status === "anonymous") return <Navigate to="/sign-in" replace />;
  if (snapshot.status === "checking") {
    return <AuthFrame title="Checking your session"><p role="status">Please wait…</p></AuthFrame>;
  }
  if (snapshot.status === "error") {
    return (
      <AuthFrame title="Session unavailable">
        <p role="alert" className="mb-4 text-sm text-muted-foreground">Your session could not be checked.</p>
        <Button onClick={() => void session.initialize()}>Try again</Button>
      </AuthFrame>
    );
  }

  const admin = snapshot.user.role === "admin";
  const routes = [
    { to: "/app", label: "Today", Icon: LayoutDashboard },
    { to: "/app/meals", label: "Meals", Icon: NotebookPen },
    { to: "/app/foods", label: "Food", Icon: Utensils },
    { to: "/app/ingredients", label: "Recipes and pantry", Icon: List },
    { to: "/app/profile", label: "Settings", Icon: Settings },
  ];
  return (
    <div className="min-h-svh md:grid md:grid-cols-[4.5rem_minmax(0,1fr)] lg:grid-cols-[14rem_minmax(0,1fr)]">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-40 focus:bg-card focus:p-3">
        Skip to content
      </a>
      <aside className={`tempo-rail ${admin ? "tempo-admin-rail" : ""} bg-rail text-rail-foreground md:sticky md:top-0 md:flex md:h-svh md:flex-col`}>
        <header className="flex min-h-16 items-center justify-between gap-3 px-5 md:justify-center md:px-2 lg:justify-between lg:px-5">
          <Link to="/app" aria-label="Fit Tempo dashboard" className="md:hidden lg:inline-flex"><Brand /></Link>
          <Link to="/app" aria-label="Fit Tempo dashboard" className="hidden font-bold md:inline-flex lg:hidden">{admin ? "Admin" : "FT"}</Link>
          {admin && <span className="rounded-full bg-background px-2 py-0.5 text-sm font-semibold text-foreground md:hidden lg:inline">Admin</span>}
          <Button variant="outline" className="md:hidden" disabled={signingOut} onClick={signOut}>
            <LogOut aria-hidden="true" size={17} /> {signingOut ? "Signing out." : "Sign out"}
          </Button>
        </header>
        <nav aria-label={admin ? "Admin navigation" : "App navigation"} className="tempo-mobile-nav fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 gap-1 border-t border-border bg-rail px-1 pt-1 pb-[max(.25rem,env(safe-area-inset-bottom))] md:static md:flex md:flex-1 md:flex-col md:border-t-0 md:px-2">
          {routes.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} end={to === "/app"} title={label} aria-label={label}
              className="tempo-nav-link relative flex min-h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1 text-center text-xs leading-tight md:flex-row md:gap-3 md:text-sm lg:justify-start lg:px-4">
              <Icon aria-hidden="true" size={19} className="shrink-0" />
              <span className="md:sr-only lg:not-sr-only">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="hidden px-2 pb-4 md:block lg:px-4">
          <Button variant="outline" className="w-full" aria-label="Sign out" title="Sign out" disabled={signingOut} onClick={signOut}>
            <LogOut aria-hidden="true" size={17} /> <span className="sr-only lg:not-sr-only">{signingOut ? "Signing out." : "Sign out"}</span>
          </Button>
        </div>
      </aside>
      <main id="main-content" tabIndex={-1} className="mx-auto w-full min-w-0 max-w-6xl px-5 pt-6 pb-28 sm:px-8 md:py-10 xl:px-12">
        {admin && <p className="mb-4 text-sm font-medium text-muted-foreground">Admin workspace</p>}
        {failure && <p role="alert" className="mb-4 flex items-start gap-2 text-sm text-destructive"><CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{failure}</p>}
        {!signingOut && <Outlet key={snapshot.user.id} />}
      </main>
    </div>
  );

  function signOut() {
    setFailure("");
    setSigningOut(true);
    void session.signOut().catch((error: unknown) => {
      setFailure(error instanceof Error ? error.message : "Sign out failed. Please try again.");
    }).finally(() => setSigningOut(false));
  }
}

export function DashboardPage() {
  return <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>;
}
