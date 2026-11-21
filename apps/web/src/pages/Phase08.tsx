import { TempoCanvas } from '@/components/shared/TempoCanvas';
import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert, CircleCheck } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { AppNavigation } from "@/components/shared/AppNavigation";
import { AccountLayout } from "@/components/shared/AccountLayout";
import { FitTempoBrand } from "@/components/shared/FitTempoBrand";
import { DayStrip, type DayEvent } from "@/components/shared/DayStrip";
import { GlassPanel } from "@/components/shared/GlassPanel";
import type { Session } from "@/lib/api/session";

type SessionProps = { session: Session };
const inputClass = "tempo-field";

const sampleEvents = [
  { id: "sample-breakfast", occurredAt: "2026-11-19T00:00:00Z", kind: "meal", name: "Oats and berries", amount: "1 bowl" },
  { id: "sample-lunch", occurredAt: "2026-11-19T04:35:00Z", kind: "meal", name: "Rice and vegetables", amount: "1 plate" },
  { id: "sample-dinner", occurredAt: "2026-11-19T11:15:00Z", kind: "meal", name: "Soup and toast", amount: "1 serving" },
] satisfies DayEvent[];

function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="tempo-canvas mx-auto grid min-h-svh max-w-7xl content-start gap-4 px-4 py-6 sm:px-8 md:gap-5 lg:content-center lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:py-16">
      <TempoCanvas />
      <div className="min-w-0 space-y-5">
        <FitTempoBrand />
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <GlassPanel tone="solid">{children}</GlassPanel>
      </div>
      <aside className="min-w-0 lg:pt-12">
        <details className="space-y-3">
          <summary className="min-h-11 cursor-pointer content-center font-medium">Preview a sample day</summary>
          <p className="tempo-wordmark text-xl font-bold tracking-tight">Your meals. Your movement. Your rhythm.</p>
          <DayStrip date="2026-11-19" timeZone="Asia/Manila" events={sampleEvents} sample panel />
        </details>
      </aside>
    </main>
  );
}

function AuthLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-4" to={to}>
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
  const redesigned = mode === "signIn" || mode === "register";
  const Layout = redesigned || mode === "resend" ? AccountLayout : AuthFrame;
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
          setMessage("Request received. If your account still needs verification, check your inbox and spam folder for a link.");
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
    <Layout title={config.title} intro={(redesigned || mode === "resend") && (
      <p className="account-intro text-sm text-muted-foreground">
        {mode === "resend" ? "Enter the email address you used to create your Fit Tempo account."
          : mode === "signIn" ? <>New to Fit Tempo? <AuthLink to="/register">Create account</AuthLink></>
          : <>Already have an account? <AuthLink to="/sign-in">Sign in</AuthLink></>}
      </p>
    )}>
      <form className="space-y-4" noValidate onSubmit={(event) => {
        setFailure("");
        setMessage("");
        void submit(event);
      }}>
        {config.email && (
          <div className="space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="account-email">Email address</label>
            <input id="account-email" type="email" autoComplete={redesigned ? "username" : "email"} className={inputClass}
              required spellCheck={false} enterKeyHint={config.password ? "next" : "go"}
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
            <input id="account-password" type="password" className={inputClass} required enterKeyHint="go"
              autoComplete={mode === "signIn" ? "current-password" : "new-password"}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? "account-password-error" : undefined} {...register("password")} />
            {errors.password && (
              <p id="account-password-error" className="flex items-start gap-2 text-sm text-destructive"><CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{errors.password.message}</p>
            )}
            {mode === "signIn" && <AuthLink to="/forgot-password">Forgot password?</AuthLink>}
          </div>
        )}
        {failure && <p role="alert" className="flex items-start gap-2 text-sm text-destructive"><CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{failure}</p>}
        {mode === "resend" ? (
          <div role="status">
            {isSubmitting ? <p className="text-sm text-muted-foreground">Requesting a verification link…</p>
              : message && <p className="text-sm text-success">{message}</p>}
          </div>
        ) : message && <p role="status" className="flex items-start gap-2 text-sm text-success"><CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{message}</p>}
        <Button type="submit" className="min-h-11 w-full" disabled={isSubmitting || (mode === "signIn" && snapshot.status === "checking") || (mode === "reset" && Boolean(message))}>
          {isSubmitting ? "Please wait…" : config.button}
        </Button>
      </form>
      {mode !== "register" && (
        <div className="mt-3 text-sm">
          {mode === "signIn" ? <AuthLink to="/resend-verification">Resend verification</AuthLink>
            : <AuthLink to="/sign-in">Go to sign in</AuthLink>}
        </div>
      )}
    </Layout>
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
    <AccountLayout title="Verify your email" intro={state !== "verified" && (
      <p className="account-intro text-sm text-muted-foreground">
        {token ? "Confirm your email address to finish setting up your Fit Tempo account."
          : "Open the verification link from your email, or request a new one."}
      </p>
    )}>
      <div role="status">
        {state === "verified" && <p className="mb-4 mt-3 flex items-start gap-2 text-sm text-success"><CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />Email verified. You can now sign in.</p>}
      </div>
      {error && <p role="alert" className="mb-4 flex items-start gap-2 text-sm text-destructive"><CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{error}</p>}
      {token && state !== "verified" && (
        <Button type="button" className="w-full" disabled={state === "working"} onClick={() => {
          setError("");
          setState("working");
          void session.verifyEmail(token).then(() => setState("verified"), (reason: unknown) => {
            setState("idle");
            setError(reason instanceof Error ? reason.message : "Verification failed. Try requesting a new link.");
          });
        }}>{state === "working" ? "Verifying…" : "Verify email"}</Button>
      )}
      {state === "verified" ? (
        <Button asChild className="w-full"><Link to="/sign-in">Go to sign in</Link></Button>
      ) : (
        <>
          {!token && <Button asChild className="w-full"><Link to="/resend-verification">Request a new link</Link></Button>}
          <div className="mt-3 flex flex-wrap gap-x-4 text-sm">
            <AuthLink to="/sign-in">Go to sign in</AuthLink>
            {token && <AuthLink to="/resend-verification">Request a new link</AuthLink>}
          </div>
        </>
      )}
    </AccountLayout>
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
  return (
    <div className={`tempo-canvas ${admin ? "tempo-canvas-admin" : ""} min-h-svh md:grid md:grid-cols-[4.5rem_minmax(0,1fr)] lg:grid-cols-[14rem_minmax(0,1fr)]`}>
      <TempoCanvas />
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-40 focus:bg-card focus:p-3">
        Skip to content
      </a>
      <AppNavigation admin={admin} brand={<FitTempoBrand />} onSignOut={signOut} signingOut={signingOut} />
      <main id="main-content" tabIndex={-1} className="tempo-mobile-content mx-auto w-full min-w-0 max-w-6xl px-5 pt-6 sm:px-8 md:py-10 xl:px-12">
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
