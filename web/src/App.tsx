import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { ThemeProvider } from './lib/theme';
import { OpsDrawerProvider } from './lib/opsDrawer';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { InfraPage } from './pages/InfraPage';
import { NomadPage } from './pages/NomadPage';
import { VaultPage } from './pages/VaultPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { JobCenterPage } from './pages/JobCenterPage';
import { OperationsPage } from './pages/OperationsPage';
import { CronPage } from './pages/CronPage';
import { AuditPage } from './pages/AuditPage';
import { MigrationBackupPage } from './pages/MigrationBackupPage';
import { SettingsPage } from './pages/SettingsPage';
import { AccountsPage } from './pages/AccountsPage';
import { VersionPage } from './pages/VersionPage';

function AppRoutes() {
  const { loading, authenticated } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        正在加载 NomadDeck 控制面...
      </div>
    );
  }
  if (!authenticated) {
    return <LoginPage />;
  }
  return (
    <OpsDrawerProvider>
      <Layout>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/infra" element={<InfraPage />} />
          <Route path="/nomad" element={<NomadPage />} />
          <Route path="/vault" element={<VaultPage />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/jobs" element={<JobCenterPage />} />
          <Route path="/operations" element={<OperationsPage />} />
          <Route path="/cron" element={<CronPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/migration-backup" element={<MigrationBackupPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/version" element={<VersionPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </OpsDrawerProvider>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
