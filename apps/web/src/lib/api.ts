/**
 * Fetch wrapper for the Roomly API.
 *
 * The access token lives only in this module's memory, never in localStorage, so
 * an XSS payload cannot lift a long-lived credential from storage. On a 401 we
 * refresh once (using the httpOnly cookie) and retry the request.
 */
import type { ApiErrorBody, AuthSession } from '@roomly/shared';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

let accessToken: string | null = null;
let onSessionChange: (s: AuthSession | null) => void = () => {};

export function setSessionListener(fn: (s: AuthSession | null) => void) {
  onSessionChange = fn;
}

export function applySession(session: AuthSession | null) {
  accessToken = session?.accessToken ?? null;
  onSessionChange(session);
}

export function getAccessToken() {
  return accessToken;
}

async function parseError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
  return new ApiError(res.status, body?.error.code ?? 'HTTP_ERROR', body?.error.message ?? res.statusText, body?.error.details);
}

let inflightRefresh: Promise<AuthSession | null> | null = null;

/**
 * Exchanges the refresh cookie for a new session. Refresh tokens are single-use
 * and the server treats a second use as theft, so refreshes must never overlap:
 * - within this tab, concurrent callers share one in-flight promise;
 * - across tabs (which share the cookie), the Web Locks API queues them, so a
 *   waiting tab sends the cookie the previous tab just received.
 */
export function refreshSession(): Promise<AuthSession | null> {
  inflightRefresh ??= (async () => {
    const run = async () => {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) return null;
      return (await res.json()) as AuthSession;
    };
    try {
      const session = navigator.locks ? await navigator.locks.request('roomly-refresh', run) : await run();
      applySession(session);
      return session;
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export async function apiFetch<T>(path: string, opts: { method?: Method; body?: unknown; retry?: boolean } = {}): Promise<T> {
  const { method = 'GET', body, retry = true } = opts;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });

  if (res.status === 401 && retry && accessToken) {
    const session = await refreshSession();
    if (session) return apiFetch<T>(path, { ...opts, retry: false });
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PUT', body }),
  delete: <T = void>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};
