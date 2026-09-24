import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth, useSession } from '../lib/auth';
import { RealtimeProvider } from '../lib/realtime';
import { Logo } from './Logo';
import { Badge, Spinner, cx } from './ui';

function NavItem({ to, children }: { to: string; children: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        cx('whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
          isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')
      }
    >
      {children}
    </NavLink>
  );
}

export function AppLayout() {
  const { user, org } = useSession();
  const { logout } = useAuth();
  const isAdmin = user.role === 'admin';

  return (
    <RealtimeProvider>
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
          <Logo />
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
            <NavItem to="/">Book a room</NavItem>
            <NavItem to="/bookings">My bookings</NavItem>
            <NavItem to="/settings">Settings</NavItem>
            {isAdmin && (
              <>
                <span className="mx-2 h-5 w-px bg-slate-200" />
                <NavItem to="/admin/spaces">Spaces</NavItem>
                <NavItem to="/admin/team">Team</NavItem>
                <NavItem to="/admin/billing">Billing</NavItem>
              </>
            )}
          </nav>
          <div className="flex items-center gap-3">
            <div className="hidden text-right lg:block">
              <div className="text-sm font-medium text-slate-900">{user.name}</div>
              <div className="flex items-center justify-end gap-1.5 text-xs text-slate-500">
                {org.name}
                {isAdmin && <Badge tone="indigo">Admin</Badge>}
              </div>
            </div>
            <button onClick={logout} className="rounded-md px-2.5 py-1.5 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-900">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <Suspense fallback={<Spinner />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
    </RealtimeProvider>
  );
}
