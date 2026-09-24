import { lazy } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth, useSession } from './lib/auth';
import { AppLayout } from './components/AppLayout';
import { Spinner } from './components/ui';
import { LoginPage } from './pages/auth/LoginPage';
import { SignupPage } from './pages/auth/SignupPage';
import { AcceptInvitePage } from './pages/auth/AcceptInvitePage';
import { HomePage } from './pages/HomePage';
import { MyBookingsPage } from './pages/MyBookingsPage';
import { SettingsPage } from './pages/SettingsPage';

// Code-split: the room calendar pulls in FullCalendar, and admin pages are rarely visited.
const RoomPage = lazy(() => import('./pages/RoomPage').then((m) => ({ default: m.RoomPage })));
const SpacesPage = lazy(() => import('./pages/admin/SpacesPage').then((m) => ({ default: m.SpacesPage })));
const TeamPage = lazy(() => import('./pages/admin/TeamPage').then((m) => ({ default: m.TeamPage })));
const BillingPage = lazy(() => import('./pages/admin/BillingPage').then((m) => ({ default: m.BillingPage })));

function FullPageSpinner() {
  return <div className="flex min-h-screen items-center justify-center"><Spinner /></div>;
}

function RequireAuth() {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <FullPageSpinner />;
  if (state.status === 'signed-out') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

function RequireAdmin() {
  const { user } = useSession();
  return user.role === 'admin' ? <Outlet /> : <Navigate to="/" replace />;
}

function GuestOnly() {
  const { state } = useAuth();
  if (state.status === 'loading') return <FullPageSpinner />;
  if (state.status === 'signed-in') return <Navigate to="/" replace />;
  return <Outlet />;
}

export function App() {
  return (
    <Routes>
      <Route element={<GuestOnly />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
      </Route>
      <Route path="/invite/:token" element={<AcceptInvitePage />} />

      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route index element={<HomePage />} />
          <Route path="/rooms/:id" element={<RoomPage />} />
          <Route path="/bookings" element={<MyBookingsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route element={<RequireAdmin />}>
            <Route path="/admin/spaces" element={<SpacesPage />} />
            <Route path="/admin/team" element={<TeamPage />} />
            <Route path="/admin/billing" element={<BillingPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
