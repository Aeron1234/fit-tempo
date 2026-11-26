import { lazy, Suspense } from 'react'
import { createBrowserRouter } from 'react-router-dom'
import { LandingPage } from '@/pages/LandingPage'
import { ScaffoldPage } from '@/pages/ScaffoldPage'
import { RouteErrorPage } from '@/pages/RouteErrorPage'
import {
  ForgotPasswordPage, ProtectedLayout, RegisterPage,
  ResendVerificationPage, ResetPasswordPage, SignInPage, VerifyEmailPage,
} from '@/pages/Phase08'
import { DashboardPage, ProfilePage } from '@/pages/Phase09'
import { FoodCatalogPage } from '@/pages/Phase10'
import { IngredientsPage } from '@/pages/IngredientsPage'
import { FoodRecognitionPage } from '@/pages/FoodRecognition'
import { AdminPage } from '@/pages/Admin'
import { NotificationSettingsPage } from '@/pages/NotificationSettings'
import { GoalsPage } from '@/pages/Goals'
import { FitMyWeekPage } from '@/pages/FitMyWeek'
import { WorkoutsPage } from '@/pages/Workouts'
import { ExercisesPage } from '@/pages/Exercises'
import { PlannerPage } from '@/pages/Planner'
import { MealsPage } from '@/pages/MealsPage'
import { AccountTheme } from '@/app/AccountTheme'
import type { Session } from '@/lib/api/session'
import { LazyRouteSkeleton } from '@/components/shared/LoadingSkeleton'

const AnalyticsPage = lazy(() => import('@/pages/Analytics').then(module => ({ default: module.AnalyticsPage })))
const ActivityProgressPage = lazy(() => import('@/pages/ActivityProgress').then(module => ({ default: module.ActivityProgressPage })))

export function createAppRouter(session: Session) {
  return createBrowserRouter([{
    errorElement: <RouteErrorPage />,
    children: [
      { path: '/', element: <LandingPage /> },
      { path: '/sign-in', element: <SignInPage session={session} /> },
      { path: '/register', element: <RegisterPage session={session} /> },
      { path: '/verify-email', element: <VerifyEmailPage session={session} /> },
      { path: '/forgot-password', element: <ForgotPasswordPage session={session} /> },
      { path: '/reset-password', element: <ResetPasswordPage session={session} /> },
      { path: '/resend-verification', element: <ResendVerificationPage session={session} /> },
      {
        element: <><AccountTheme session={session} /><ProtectedLayout session={session} /></>,
        children: [
          { path: '/app', element: <DashboardPage session={session} /> },
          { path: '/app/profile', element: <ProfilePage session={session} /> },
          { path: '/app/admin', element: <AdminPage session={session} /> },
          { path: '/app/notifications', element: <NotificationSettingsPage session={session} /> },
          { path: '/app/meals', element: <MealsPage session={session} /> },
          { path: '/app/ingredients', element: <IngredientsPage session={session} /> },
          { path: '/app/food-recognition', element: <FoodRecognitionPage session={session} /> },
          { path: '/app/analytics', element: <Suspense fallback={<LazyRouteSkeleton />}>
            <AnalyticsPage session={session} />
          </Suspense> },
          { path: '/app/goals', element: <GoalsPage session={session} /> },
          { path: '/app/activity', element: <Suspense fallback={<LazyRouteSkeleton activity />}>
            <ActivityProgressPage session={session} />
          </Suspense> },
          { path: '/app/week', element: <FitMyWeekPage session={session} /> },
          { path: '/app/workouts', element: <WorkoutsPage session={session} /> },
          { path: '/app/exercises', element: <ExercisesPage session={session} /> },
          { path: '/app/planner', element: <PlannerPage session={session} /> },
          { path: '/app/foods', element: <FoodCatalogPage session={session} /> },
          { path: '/development-preview', element: <ScaffoldPage /> },
        ],
      },
      { path: '*', element: <RouteErrorPage notFound /> },
    ],
  }])
}
