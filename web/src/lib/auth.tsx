import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiGet, apiPost, setCSRFToken } from './api';

export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'viewer';
}

interface AuthState {
  loading: boolean;
  needsSetup: boolean;
  authenticated: boolean;
  user: AuthUser | null;
  isAdmin: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  loading: true,
  needsSetup: false,
  authenticated: false,
  user: null,
  isAdmin: false,
  refresh: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await apiGet<{
        needs_setup: boolean;
        authenticated: boolean;
        user?: AuthUser;
        csrf_token?: string;
      }>('/api/v1/auth/status');
      setNeedsSetup(Boolean(data.needs_setup));
      setAuthenticated(Boolean(data.authenticated));
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

  const logout = useCallback(async () => {
    try {
      await apiPost('/api/v1/auth/logout');
    } finally {
      setCSRFToken('');
      setAuthenticated(false);
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        loading,
        needsSetup,
        authenticated,
        user,
        isAdmin: user?.role === 'admin',
        refresh,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
