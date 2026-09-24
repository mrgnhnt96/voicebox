import { Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { useServerHealth } from '@/lib/hooks/useServer';
import { usePlatform } from '@/platform/PlatformContext';
import { SettingRow, SettingSection } from './SettingRow';
import { ThemeSelect } from './ThemeSelect';

export function GeneralPage() {
  const { t } = useTranslation();
  const platform = usePlatform();
  const { toast } = useToast();
  const [restarting, setRestarting] = useState(false);
  const { data: health, isLoading, error: healthError } = useServerHealth();

  return (
    <div className="space-y-8 max-w-2xl">
      <SettingSection>
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
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${restarting ? 'animate-spin' : ''}`} />
                {t(restarting ? 'settings.general.restart.busy' : 'settings.general.restart.title')}
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
    </div>
  );
}

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
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-border/60 px-3 py-1">
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          {t('settings.general.connection.connecting')}
        </span>
      </div>
    );
  }
  if (healthError) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-destructive/30 px-3 py-1">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-destructive/40" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
        </span>
        <span className="text-xs text-destructive">{t('settings.general.connection.offline')}</span>
      </div>
    );
  }
  if (health) {
    return (
      <div className="flex items-center gap-2 rounded-full border border-accent/30 px-3 py-1">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent shadow-[0_0_6px_1px_hsl(var(--accent)/0.5)]" />
        </span>
        <span className="text-xs text-muted-foreground">
          {t('settings.general.connection.online')}
        </span>
      </div>
    );
  }
  return null;
}
