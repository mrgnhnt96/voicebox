import { FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { useServerHealth } from '@/lib/hooks/useServer';
import { cn } from '@/lib/utils/cn';
import { usePlatform } from '@/platform/PlatformContext';
import { SERVER_URL } from '@/stores/serverStore';
import { SettingRow, SettingSection } from './SettingRow';
import { ThemeSelect } from './ThemeSelect';

export function GeneralPage() {
  const { t } = useTranslation();
  const platform = usePlatform();
  const { toast } = useToast();
  const [restarting, setRestarting] = useState(false);
  const { data: health, isLoading, error: healthError } = useServerHealth();

  return (
    <>
      <SettingSection title={t('settings.general.sectionApp')}>
        <SettingRow
          title={t('settings.general.server.title')}
          description={t('settings.general.server.description')}
          action={
            <ConnectionStatus health={health} isLoading={isLoading} healthError={healthError} />
          }
        />

        {platform.metadata.isTauri && (
          <SettingRow
            title={t('settings.general.restart.title')}
            description={t('settings.general.restart.description')}
            action={
              <Button
                variant="outline"
                size="sm"
                disabled={restarting}
                onClick={async () => {
                  setRestarting(true);
                  try {
                    await platform.lifecycle.restartApp();
                  } catch (error) {
                    setRestarting(false);
                    toast({
                      title: t('settings.general.restart.failed'),
                      description: String(error),
                      variant: 'destructive',
                    });
                  }
                }}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', restarting && 'animate-spin')} />
                {t(
                  restarting ? 'settings.general.restart.busy' : 'settings.general.restart.action',
                )}
              </Button>
            }
          />
        )}

        <SettingRow
          title={t('settings.theme.label')}
          description={t('settings.theme.description')}
          action={<ThemeSelect />}
        />
      </SettingSection>

      <SettingSection title={t('settings.captures.storage.title')}>
        <CapturesFolderRow />
      </SettingSection>
    </>
  );
}

/** Where captures live on disk, with a button that opens it in Finder. */
function CapturesFolderRow() {
  const { t } = useTranslation();
  const platform = usePlatform();
  const [opening, setOpening] = useState(false);
  const [capturesPath, setCapturesPath] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${SERVER_URL}/health/filesystem`)
      .then((res) => res.json())
      .then((data) => {
        const dir = data.directories?.find((d: { path: string }) => d.path.includes('captures'));
        if (dir?.path) setCapturesPath(dir.path);
      })
      .catch(() => {});
  }, []);

  const openCapturesFolder = useCallback(async () => {
    if (!capturesPath) return;
    setOpening(true);
    try {
      await platform.filesystem.openPath(capturesPath);
    } catch (e) {
      console.error('Failed to open captures folder:', e);
    } finally {
      setOpening(false);
    }
  }, [platform, capturesPath]);

  return (
    <SettingRow
      title={t('settings.captures.storage.folder.title')}
      description={
        capturesPath ? (
          <span className="font-mono text-[11px] break-all">{capturesPath}</span>
        ) : (
          t('settings.captures.storage.folder.description')
        )
      }
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={openCapturesFolder}
          disabled={opening || !capturesPath}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {t('settings.captures.storage.folder.open')}
        </Button>
      }
    />
  );
}

/** The server state as a small pill: connecting, online or offline. */
function ConnectionStatus({
  health,
  isLoading,
  healthError,
}: {
  health: ReturnType<typeof useServerHealth>['data'];
  isLoading: boolean;
  healthError: ReturnType<typeof useServerHealth>['error'];
}) {
  const { t } = useTranslation();
  const pill = 'flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-xs';
  if (isLoading) {
    return (
      <span className={cn(pill, 'bg-muted text-muted-foreground')}>
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('settings.general.connection.connecting')}
      </span>
    );
  }
  if (healthError) {
    return (
      <span className={cn(pill, 'bg-destructive/10 text-destructive')}>
        <span className="h-[7px] w-[7px] rounded-full bg-destructive" />
        {t('settings.general.connection.offline')}
      </span>
    );
  }
  if (health) {
    return (
      <span className={cn(pill, 'bg-success/10 text-success')}>
        <span className="h-[7px] w-[7px] rounded-full bg-success" />
        {t('settings.general.connection.online')}
      </span>
    );
  }
  return null;
}
