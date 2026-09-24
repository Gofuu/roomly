import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth, useSession } from './lib/auth';
import { AppLayout } from './components/AppLayout';
import { Spinner } from './components/ui';
import { LoginPage } from './pages/auth/LoginPage';
import { SignupPage } from './pages/auth/SignupPage';
import { AcceptInvitePage } from './pages/auth/AcceptInvitePage';
import { HomePage } from './pages/HomePage';
import { SpacesPage } from './pages/admin/SpacesPage';
import { TeamPage } from './pages/admin/TeamPage';

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
          <Route element={<RequireAdmin />}>
            <Route path="/admin/spaces" element={<SpacesPage />} />
            <Route path="/admin/team" element={<TeamPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
