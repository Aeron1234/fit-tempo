import { createBrowserRouter, Navigate } from 'react-router-dom'
import { ScaffoldPage } from '@/pages/ScaffoldPage'
import { RouteErrorPage } from '@/pages/RouteErrorPage'
import {
  ForgotPasswordPage, ProtectedLayout, RegisterPage,
  ResendVerificationPage, ResetPasswordPage, SignInPage, VerifyEmailPage,
} from '@/pages/Phase08'
import { DashboardPage, ProfilePage } from '@/pages/Phase09'
import { FoodCatalogPage } from '@/pages/Phase10'
import { IngredientsPage } from '@/pages/IngredientsPage'
import { MealsPage } from '@/pages/MealsPage'
import { AccountTheme } from '@/app/AccountTheme'
import type { Session } from '@/lib/api/session'

export function createAppRouter(session: Session) {
  return createBrowserRouter([{
    errorElement: <RouteErrorPage />,
    children: [
      { path: '/', element: <Navigate to="/app" replace /> },
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
          { path: '/app/meals', element: <MealsPage session={session} /> },
          { path: '/app/ingredients', element: <IngredientsPage session={session} /> },
          { path: '/app/foods', element: <FoodCatalogPage session={session} /> },
          { path: '/development-preview', element: <ScaffoldPage /> },
        ],
      },
      { path: '*', element: <RouteErrorPage /> },
    ],
  }])
}
