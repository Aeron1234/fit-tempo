import {
  Bell, ChartNoAxesCombined, ScanLine, ShieldCheck, Target, Activity, CalendarDays, ClipboardList, Dumbbell, Ellipsis, LayoutDashboard, List, NotebookPen, Settings, Timer, Utensils, X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Link, NavLink, matchPath, useLocation } from "react-router-dom";
import { SignOutAction } from './SignOutAction';
import { FitTempoMark } from './FitTempoBrand';

type Role = "trainee" | "admin";
type Group = "Food" | "Plan" | "Training" | "Account";
type NavigationItem = {
  to: string;
  shortLabel: string;
  label: string;
  Icon: LucideIcon;
  group: Group;
  primary?: Partial<Record<Role, number>>;
  adminOnly?: boolean;
};

const navigation: readonly NavigationItem[] = [
  { to: "/app", shortLabel: "Today", label: "Today", Icon: LayoutDashboard, group: "Plan", primary: { trainee: 0, admin: 0 } },
  { to: "/app/meals", shortLabel: "Meals", label: "Meals", Icon: NotebookPen, group: "Food", primary: { trainee: 1, admin: 1 } },
  { to: "/app/foods", shortLabel: "Food", label: "Food", Icon: Utensils, group: "Food", primary: { trainee: 3, admin: 2 } },
  { to: "/app/ingredients", shortLabel: "Recipes", label: "Recipes and pantry", Icon: List, group: "Food" },
  { to: "/app/planner", shortLabel: "Planner", label: "Meal planner", Icon: ClipboardList, group: "Plan" },
  { to: "/app/exercises", shortLabel: "Exercises", label: "Exercises", Icon: Dumbbell, group: "Training" },
  { to: "/app/workouts", shortLabel: "Workouts", label: "Workouts", Icon: Timer, group: "Training", primary: { trainee: 2 } },
  { to: "/app/week", shortLabel: "Week", label: "Fit My Week", Icon: CalendarDays, group: "Plan" },
  { to: "/app/activity", shortLabel: "Progress", label: "Activity and progress", Icon: Activity, group: "Training" },
  { to: "/app/goals", shortLabel: "Goals", label: "Hydration and goals", Icon: Target, group: "Plan" },
  { to: "/app/food-recognition", shortLabel: "Recognize", label: "Food recognition", Icon: ScanLine, group: "Food" },
  { to: "/app/analytics", shortLabel: "Analytics", label: "Weekly analytics", Icon: ChartNoAxesCombined, group: "Plan" },
  { to: "/app/profile", shortLabel: "Settings", label: "Settings", Icon: Settings, group: "Account", primary: { admin: 3 } },
  { to: "/app/notifications", shortLabel: "Email", label: "Email notifications", Icon: Bell, group: "Account" },
  { to: "/app/admin", shortLabel: "Admin", label: "Administration", Icon: ShieldCheck, group: "Account", adminOnly: true },
];

const groups: readonly Group[] = ["Food", "Plan", "Training", "Account"];

export function AppNavigation({ admin, brand, onSignOut, signingOut }: {
  admin: boolean;
  brand: ReactNode;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const role = admin ? "admin" : "trainee";
  const chrome = admin ? "tempo-admin-rail" : "";
  const label = admin ? "Admin navigation" : "App navigation";
  const available = navigation.filter(item => !item.adminOnly || admin);
  const primary = available.filter(item => item.primary?.[role] !== undefined)
    .sort((a, b) => a.primary![role]! - b.primary![role]!);
  const remaining = available.filter(item => item.primary?.[role] === undefined);
  const { pathname } = useLocation();
  const moreCurrent = remaining.some(item => matchPath({ path: item.to, end: item.to === "/app" }, pathname));
  const sheet = useRef<HTMLDialogElement>(null);
  const more = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = sheet.current;
    const desktop = window.matchMedia("(min-width: 768px)");
    function closeOnDesktop() {
      if (desktop.matches) dialog?.close();
    }
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    sheet.current?.close();
  }, [pathname]);

  function signOutFromSheet() {
    sheet.current?.close();
    onSignOut();
  }

  return <>
    <header className={`tempo-mobile-header tempo-rail glass-bar sticky top-0 z-20 flex items-center px-5 md:hidden ${chrome}`}>
      <Link to="/app" aria-label="Fit Tempo dashboard">{brand}</Link>
    </header>
    <aside className={`tempo-rail glass-bar hidden md:sticky md:top-0 md:flex md:h-svh md:flex-col ${chrome}`}>
      <header className="flex shrink-0 flex-col gap-2 p-2 lg:px-4 lg:py-3">
        <Link to="/app" aria-label="Fit Tempo dashboard" className="flex min-h-9 items-center justify-center lg:justify-start">
          <span className="lg:hidden"><FitTempoMark /></span>
          <span className="hidden lg:inline">{brand}</span>
        </Link>
      </header>
      <nav aria-label={label} className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-1">
        {available.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} end={to === "/app"} title={label} aria-label={label}
            className="tempo-nav-link relative flex min-h-12 min-w-0 items-center justify-center gap-3 rounded-lg px-1 py-1 text-sm lg:justify-start lg:px-4">
            <Icon aria-hidden="true" size={19} className="shrink-0" />
            <span className="sr-only lg:not-sr-only">{label}</span>
          </NavLink>
        ))}
      </nav>
      <footer className="tempo-rail-footer shrink-0 px-2">
        <SignOutAction variant="rail" busy={signingOut} onSignOut={onSignOut} />
      </footer>
    </aside>
    <nav aria-label={label} className={`tempo-mobile-nav tempo-rail glass-bar fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 md:hidden ${chrome}`}>
      {primary.map(({ to, label, shortLabel, Icon }) => (
        <NavLink key={to} to={to} end={to === "/app"} aria-label={label} className="tempo-mobile-slot">
          <span className="tempo-mobile-icon"><Icon aria-hidden="true" size={22} /></span>
          <span>{shortLabel}</span>
        </NavLink>
      ))}
      <button ref={more} type="button" className="tempo-mobile-slot" aria-haspopup="dialog"
        aria-controls="app-more-sheet" aria-current={moreCurrent ? "page" : undefined}
        onClick={() => sheet.current?.showModal()}>
        <span className="tempo-mobile-icon"><Ellipsis aria-hidden="true" size={22} /></span>
        <span>More</span>
      </button>
    </nav>
    <dialog ref={sheet} id="app-more-sheet" aria-labelledby="app-more-heading"
      className="tempo-more-sheet glass-float fixed inset-x-0 top-auto bottom-0 m-0 max-h-[85dvh] w-full max-w-none overflow-y-auto rounded-t-xl text-foreground"
      onClose={() => more.current?.focus()}>
      <div className="mx-auto max-w-xl px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between gap-3">
          <h2 id="app-more-heading" className="text-xl font-semibold">More</h2>
          <button type="button" aria-label="Close More" className="inline-flex size-11 items-center justify-center rounded-lg text-foreground"
            onClick={() => sheet.current?.close()}><X aria-hidden="true" size={20} /></button>
        </div>
        {groups.map(group => {
          const routes = remaining.filter(item => item.group === group);
          if (routes.length === 0 && group !== "Account") return null;
          return <section className="mt-2" key={group}>
            <h3 className="px-2 text-sm font-semibold text-muted-foreground">{group}</h3>
            {routes.map(({ to, label, Icon }) => (
              <NavLink key={to} to={to} end={to === "/app"} onClick={() => sheet.current?.close()}
                className="flex min-h-12 items-center gap-3 rounded-lg px-2 text-foreground hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-semibold">
                <Icon aria-hidden="true" size={20} /> {label}
              </NavLink>
            ))}
            {group === "Account" && <SignOutAction variant="sheet" busy={signingOut} onSignOut={signOutFromSheet} />}
          </section>;
        })}
      </div>
    </dialog>
  </>;
}
