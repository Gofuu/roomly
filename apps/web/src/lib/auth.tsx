import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AcceptInvitationInput, AuthSession, LoginInput, SignupInput } from '@roomly/shared';
import { applySession, apiFetch, refreshSession, setSessionListener } from './api';

type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; session: AuthSession };

interface AuthContextValue {
  state: AuthState;
  login(input: LoginInput): Promise<void>;
  signup(input: SignupInput): Promise<void>;
  acceptInvitation(input: AcceptInvitationInput): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    setSessionListener((s) => setState(s ? { status: 'signed-in', session: s } : { status: 'signed-out' }));
    // Restore the session from the refresh cookie on page load.
    refreshSession();
  }, []);

  const start = useCallback(async (path: string, body: unknown) => {
    applySession(await apiFetch<AuthSession>(path, { method: 'POST', body, retry: false }));
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    state,
    login: (input) => start('/auth/login', input),
    signup: (input) => start('/auth/signup', input),
    acceptInvitation: (input) => start('/auth/invitations/accept', input),
    logout: async () => {
      await apiFetch('/auth/logout', { method: 'POST', retry: false }).catch(() => {});
      applySession(null);
    },
  }), [state, start]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** The signed-in session. Only use inside routes guarded by RequireAuth. */
export function useSession(): AuthSession {
  const { state } = useAuth();
  if (state.status !== 'signed-in') throw new Error('useSession without a session');
  return state.session;
}
