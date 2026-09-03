import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import AppShell from './components/shell/AppShell';
import LoginPage from './pages/LoginPage';
import ProjectListPage from './pages/ProjectListPage';
import ProjectOverviewPage from './pages/ProjectOverviewPage';
import WorkbenchPage from './pages/WorkbenchPage';
import ArchitecturePage from './pages/ArchitecturePage';
import ArchitectPage from './pages/ArchitectPage';
import RequirementsPage from './pages/RequirementsPage';
import WorkItemsPage from './pages/WorkItemsPage';
import WorkItemPage from './pages/WorkItemPage';
import ProjectActivityPage from './pages/ActivityPage';
import SettingsPage from './pages/SettingsPage';
import IntegrationsPage from './pages/IntegrationsPage';
import ProviderSettingsPage from './pages/ProviderSettingsPage';
import CompanionHandoffPage from './pages/CompanionHandoffPage';
import BenchmarkListPage from './pages/BenchmarkListPage';
import BenchmarkCreatePage from './pages/BenchmarkCreatePage';
import BenchmarkDetailPage from './pages/BenchmarkDetailPage';
import BenchmarkComparisonPage from './pages/BenchmarkComparisonPage';
import BenchmarkTrialPage from './pages/BenchmarkTrialPage';
import ExecutionPreferencesPage from './pages/ExecutionPreferencesPage';
import HomePage from './pages/HomePage';
import WorkflowsPage from './pages/WorkflowsPage';
import ExplorePage from './pages/ExplorePage';
import ProductActivityPage from './pages/ProductActivityPage';
import CreatePage from './pages/CreatePage';
import ExpertPage from './pages/ExpertPage';

export default function App() {
  const { status, refreshSession } = useAuth();

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent"
          role="status"
          aria-label="Loading"
        />
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/workflows" element={<WorkflowsPage />} />
      <Route path="/explore" element={<ExplorePage />} />
      <Route path="/activity" element={<ProductActivityPage />} />
      <Route path="/create" element={<CreatePage />} />
      <Route path="/expert" element={<ExpertPage />} />

      {/* Existing project/developer control plane remains reachable. */}
      <Route path="/projects" element={<ProjectListPage />} />
      <Route path="/companion/handoff" element={<CompanionHandoffPage />} />
      <Route path="/projects/:projectId" element={<AppShell><ProjectOverviewPage /></AppShell>} />
      <Route path="/projects/:projectId/architect" element={<AppShell><ArchitectPage /></AppShell>} />
      <Route path="/projects/:projectId/architecture" element={<AppShell><ArchitecturePage /></AppShell>} />
      <Route path="/projects/:projectId/requirements" element={<AppShell><RequirementsPage /></AppShell>} />
      <Route path="/projects/:projectId/workbench" element={<AppShell><WorkbenchPage /></AppShell>} />
      <Route path="/projects/:projectId/work-items" element={<AppShell><WorkItemsPage /></AppShell>} />
      <Route path="/work-items/:workItemId" element={<AppShell><WorkItemPage /></AppShell>} />
      <Route path="/projects/:projectId/activity" element={<AppShell><ProjectActivityPage /></AppShell>} />
      <Route path="/projects/:projectId/settings" element={<AppShell><SettingsPage /></AppShell>} />
      <Route path="/projects/:projectId/settings/execution" element={<AppShell><ExecutionPreferencesPage /></AppShell>} />
      <Route path="/projects/:projectId/integrations" element={<AppShell><IntegrationsPage /></AppShell>} />
      <Route path="/settings/providers" element={<AppShell><ProviderSettingsPage /></AppShell>} />
      <Route path="/benchmarks" element={<AppShell><BenchmarkListPage /></AppShell>} />
      <Route path="/benchmarks/new" element={<AppShell><BenchmarkCreatePage /></AppShell>} />
      <Route path="/benchmarks/:benchmarkId" element={<AppShell><BenchmarkDetailPage /></AppShell>} />
      <Route path="/benchmarks/:benchmarkId/compare" element={<AppShell><BenchmarkComparisonPage /></AppShell>} />
      <Route path="/benchmarks/trials/:trialId" element={<AppShell><BenchmarkTrialPage /></AppShell>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
