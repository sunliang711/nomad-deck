import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  apiGet,
  apiPost,
  isReauthenticating,
  setCSRFToken,
  setUnauthorizedHandler,
} from './api';
import { useToast } from '../components/Toast';

export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'viewer';
}

interface AuthState {
  loading: boolean;
  needsSetup: boolean;
  authenticated: boolean;
  version: string;
  user: AuthUser | null;
  isAdmin: boolean;
  sessionExpired: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  completeReauth: (user: AuthUser, csrfToken?: string) => void;
  abortReauth: () => void;
}

const AuthContext = createContext<AuthState>({
  loading: true,
  needsSetup: false,
  authenticated: false,
  version: '',
  user: null,
  isAdmin: false,
  sessionExpired: false,
  refresh: async () => {},
  logout: async () => {},
  completeReauth: () => {},
  abortReauth: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { clearHistory } = useToast();
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [version, setVersion] = useState('');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const reauthResolversRef = useRef<((ok: boolean) => void)[]>([]);

  const settleReauth = useCallback((ok: boolean) => {
    setSessionExpired(false);
    while (reauthResolversRef.current.length > 0) {
      reauthResolversRef.current.shift()?.(ok);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await apiGet<{
        needs_setup: boolean;
        authenticated: boolean;
        version?: string;
        user?: AuthUser;
        csrf_token?: string;
      }>('/api/v1/auth/status', { skipAuthPrompt: true });
      setNeedsSetup(Boolean(data.needs_setup));
      setAuthenticated(Boolean(data.authenticated));
      setVersion(data.version || '');
      setUser(data.user || null);
      setCSRFToken(data.csrf_token || '');
    } catch {
      setAuthenticated(false);
      setUser(null);
      setCSRFToken('');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!authenticated) {
      setUnauthorizedHandler(null);
      settleReauth(false);
      return;
    }

    setUnauthorizedHandler(
      () =>
        new Promise<boolean>((resolve) => {
          reauthResolversRef.current.push(resolve);
          setSessionExpired(true);
        }),
    );

    let lastCheckedAt = Date.now();
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible' || isReauthenticating()) return;
      const now = Date.now();
      if (now - lastCheckedAt < 60_000) return;
      lastCheckedAt = now;
      void apiGet<{ authenticated: boolean; user?: AuthUser; csrf_token?: string; version?: string }>(
        '/api/v1/auth/status',
        { skipAuthPrompt: true },
      )
        .then((res) => {
          if (res.version) setVersion(res.version);
          if (!res.authenticated) {
            setSessionExpired(true);
            return;
          }
          if (res.user) setUser(res.user);
          if (res.csrf_token) setCSRFToken(res.csrf_token);
        })
        .catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      setUnauthorizedHandler(null);
      settleReauth(false);
    };
  }, [authenticated, settleReauth]);

  const completeReauth = useCallback(
    (nextUser: AuthUser, nextCSRF?: string) => {
      if (nextCSRF) setCSRFToken(nextCSRF);
      setUser(nextUser);
      setAuthenticated(true);
      settleReauth(true);
    },
    [settleReauth],
  );

  const abortReauth = useCallback(() => {
    settleReauth(false);
    setCSRFToken('');
    setAuthenticated(false);
    setUser(null);
    clearHistory();
  }, [settleReauth, clearHistory]);

  const logout = useCallback(async () => {
    try {
      await apiPost('/api/v1/auth/logout', undefined, { skipAuthPrompt: true });
    } catch {
      // ignore logout network errors
    } finally {
      settleReauth(false);
      setCSRFToken('');
      setAuthenticated(false);
      setUser(null);
      clearHistory();
    }
  }, [settleReauth, clearHistory]);

  return (
    <AuthContext.Provider
      value={{
        loading,
        needsSetup,
        authenticated,
        version,
        user,
        isAdmin: user?.role === 'admin',
        sessionExpired,
        refresh,
        logout,
        completeReauth,
        abortReauth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
