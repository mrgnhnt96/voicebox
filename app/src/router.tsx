import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AppFrame } from '@/components/AppFrame/AppFrame';
import { CapturesTab } from '@/components/CapturesTab/CapturesTab';
import { CommandPalette } from '@/components/CommandPalette/CommandPalette';
import { ModelsTab } from '@/components/ModelsTab/ModelsTab';
import { GeneralPage } from '@/components/ServerTab/GeneralPage';
import { LogsPage } from '@/components/ServerTab/LogsPage';
import { SettingsLayout } from '@/components/ServerTab/ServerTab';
import { DictationSettingsPage } from '@/components/Settings/DictationSettingsPage';
import { TranscriptionSettingsPage } from '@/components/Settings/TranscriptionSettingsPage';
import { WritingStylePage } from '@/components/Settings/WritingStylePage';
import { SetupFlow } from '@/components/Setup/SetupFlow';
import { useFirstRunRedirect } from '@/components/Setup/useFirstRunRedirect';
import { Sidebar } from '@/components/Sidebar';
import { StatusBar } from '@/components/StatusBar';
import { Toaster } from '@/components/ui/toaster';
import { useModelDownloadToast } from '@/lib/hooks/useModelDownloadToast';
import { MODEL_DISPLAY_NAMES, useRestoreActiveTasks } from '@/lib/hooks/useRestoreActiveTasks';

// Root layout component
function RootLayout() {
  // Monitor active model downloads and show toasts for them
  const activeDownloads = useRestoreActiveTasks();
  // Send a brand-new user to /setup, once per launch.
  useFirstRunRedirect();

  return (
    <AppFrame>
      <div className="flex flex-1 min-h-0 overflow-hidden border-t border-border">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-hidden flex flex-col">
          <Outlet />
        </main>
      </div>
      <StatusBar />
      <CommandPalette />

      {/* Show download toasts for any active downloads (from anywhere) */}
      {activeDownloads.map((download) => {
        const displayName = MODEL_DISPLAY_NAMES[download.model_name] || download.model_name;
        return (
          <DownloadToastRestorer
            key={download.model_name}
            modelName={download.model_name}
            displayName={displayName}
          />
        );
      })}

      <Toaster />
    </AppFrame>
  );
}

/**
 * Component that restores a download toast for a specific model.
 */
function DownloadToastRestorer({
  modelName,
  displayName,
}: {
  modelName: string;
  displayName: string;
}) {
  // Use the download toast hook to restore the toast
  useModelDownloadToast({
    modelName,
    displayName,
    enabled: true,
  });

  return null;
}

// Root route with layout
const rootRoute = createRootRoute({
  component: RootLayout,
});

// Index route — dictation is the whole app, so land on Captures.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/captures' });
  },
});

// Captures route
const capturesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/captures',
  component: CapturesTab,
  // `?capture=<id>` opens that capture (the command palette links here).
  validateSearch: (search: Record<string, unknown>): { capture?: string } => ({
    capture: typeof search.capture === 'string' ? search.capture : undefined,
  }),
});

// Models route
const modelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/models',
  component: ModelsTab,
});

// Settings layout route (parent for sub-tabs)
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsLayout,
});

// Settings sub-routes
const settingsGeneralRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  component: GeneralPage,
});

const settingsDictationRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/dictation',
  component: DictationSettingsPage,
});

const settingsTranscriptionRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/transcription',
  component: TranscriptionSettingsPage,
});

const settingsWritingStyleRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/writing-style',
  component: WritingStylePage,
});

// Dictation, transcription and writing style used to share one page.
const settingsCapturesRedirectRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/captures',
  beforeLoad: () => {
    throw redirect({ to: '/settings/dictation' });
  },
});

const settingsLogsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/logs',
  component: LogsPage,
});

// First-run setup: models, permissions, shortcut, try it.
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  component: SetupFlow,
});

// Redirect old /server path to /settings
const serverRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/server',
  beforeLoad: () => {
    throw redirect({ to: '/settings' });
  },
});

// Route tree
const routeTree = rootRoute.addChildren([
  indexRoute,
  capturesRoute,
  modelsRoute,
  settingsRoute.addChildren([
    settingsGeneralRoute,
    settingsDictationRoute,
    settingsTranscriptionRoute,
    settingsWritingStyleRoute,
    settingsCapturesRedirectRoute,
    settingsLogsRoute,
  ]),
  setupRoute,
  serverRedirectRoute,
]);

// Create router
export const router = createRouter({ routeTree });

// Register router for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
