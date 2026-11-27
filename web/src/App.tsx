import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { useI18n } from './lib/i18n';
import { OpsDrawerProvider } from './lib/opsDrawer';
import { Layout } from './components/Layout';
import { LoadingState } from './components/UI';
import { LoginPage, SessionExpiredModal } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { InfraPage } from './pages/InfraPage';
import { NomadPage } from './pages/NomadPage';
import { VaultPage } from './pages/VaultPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { JobCenterPage } from './pages/JobCenterPage';
import { CronPage } from './pages/CronPage';
import { AuditPage } from './pages/AuditPage';
import { MigrationBackupPage } from './pages/MigrationBackupPage';
import { SettingsPage } from './pages/SettingsPage';
import { AccountsPage } from './pages/AccountsPage';
import { VersionPage } from './pages/VersionPage';

function AppRoutes() {
  const { loading, authenticated, sessionExpired } = useAuth();
  const { tr } = useI18n();
  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center bg-[#f5f7fb] dark:bg-[#0b1120]">
        <LoadingState label={tr('正在加载 NomadDeck 控制面...', 'Loading NomadDeck Control Plane...')} />
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
          <Route path="/operations" element={<Navigate to="/audit" replace />} />
          <Route path="/cron" element={<CronPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/migration-backup" element={<MigrationBackupPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/version" element={<VersionPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
      {sessionExpired && <SessionExpiredModal />}
    </OpsDrawerProvider>
  );
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
