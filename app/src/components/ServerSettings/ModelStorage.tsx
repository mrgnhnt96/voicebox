import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import { usePlatform } from '@/platform/PlatformContext';
import { useServerStore } from '@/stores/serverStore';
import { formatBytes } from './modelCatalog';

interface MigrationProgress {
  current: number;
  total: number;
  progress: number;
  filename?: string;
  status: string;
}

const storageButton = 'h-6 px-2 font-mono text-[11px] font-normal';

/**
 * The model storage folder, with Open, Move… (migrate to a new folder) and
 * Reset (back to the default folder).
 */
export function ModelStorage({ cacheDir }: { cacheDir: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const platform = usePlatform();
  const customModelsDir = useServerStore((state) => state.customModelsDir);
  const setCustomModelsDir = useServerStore((state) => state.setCustomModelsDir);
  const [migrating, setMigrating] = useState(false);
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgress | null>(null);
  const [pendingMigrateDir, setPendingMigrateDir] = useState<string | null>(null);

  const openFolder = async () => {
    try {
      await platform.filesystem.openPath(cacheDir);
    } catch {
      toast({ title: t('models.toast.openFolderFailed'), variant: 'destructive' });
    }
  };

  const pickFolder = async () => {
    try {
      const newDir = await platform.filesystem.pickDirectory(t('models.storage.pickerTitle'));
      if (!newDir) return;
      setPendingMigrateDir(newDir);
    } catch {
      toast({ title: t('models.toast.pickerFailed'), variant: 'destructive' });
    }
  };

  const resetFolder = async () => {
    setCustomModelsDir(null);
    toast({ title: t('models.toast.resetToDefault') });
    await platform.lifecycle.restartServer('');
    queryClient.invalidateQueries();
  };

  const migrate = async () => {
    if (!pendingMigrateDir) return;
    const newDir = pendingMigrateDir;
    setPendingMigrateDir(null);
    setMigrating(true);
    setMigrationProgress({
      current: 0,
      total: 0,
      progress: 0,
      status: 'downloading',
      filename: t('models.migrateDialog.preparing'),
    });
    try {
      // Start the migration (background task)
      const migrationResult = await apiClient.migrateModels(newDir);

      // If no models to migrate, warn user and skip the change
      if (migrationResult.moved === 0) {
        toast({
          title: t('models.toast.noModelsToMigrate'),
          description: t('models.toast.noModelsToMigrateDescription'),
        });
        return;
      }

      // Connect to SSE for progress
      await new Promise<void>((resolve, reject) => {
        const es = new EventSource(apiClient.getMigrationProgressUrl());
        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            setMigrationProgress(data);
            if (data.status === 'complete') {
              es.close();
              resolve();
            } else if (data.status === 'error') {
              es.close();
              reject(new Error(data.error || t('models.toast.migrationFailed')));
            }
          } catch {
            /* ignore parse errors */
          }
        };
        es.onerror = () => {
          es.close();
          reject(new Error(t('models.toast.migrationConnectionLost')));
        };
      });

      setCustomModelsDir(newDir);
      setMigrationProgress({
        current: 1,
        total: 1,
        progress: 100,
        status: 'complete',
        filename: t('models.migrateDialog.restartingServer'),
      });
      await platform.lifecycle.restartServer(newDir);
      queryClient.invalidateQueries();
      toast({ title: t('models.toast.migrated') });
    } catch (e) {
      toast({
        title: t('models.toast.migrationFailed'),
        description: e instanceof Error ? e.message : t('models.toast.migrationFailedGeneric'),
        variant: 'destructive',
      });
    } finally {
      setMigrating(false);
      setMigrationProgress(null);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={cacheDir}>
          {cacheDir}
        </span>
        <Button variant="outline" size="sm" className={storageButton} onClick={openFolder}>
          {t('models.storage.open')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={storageButton}
          onClick={pickFolder}
          disabled={migrating}
        >
          {migrating && <Loader2 className="h-3 w-3 animate-spin" />}
          {migrating ? t('models.storage.migrating') : t('models.storage.move')}
        </Button>
        {customModelsDir && (
          <Button
            variant="ghost"
            size="sm"
            className={storageButton}
            onClick={resetFolder}
            disabled={migrating}
          >
            {t('models.storage.reset')}
          </Button>
        )}
      </div>

      <AlertDialog
        open={!!pendingMigrateDir}
        onOpenChange={(open) => !open && setPendingMigrateDir(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('models.migrateDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('models.migrateDialog.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div
            className="truncate rounded-md border border-border bg-muted px-3 py-2 font-mono text-[11px] text-muted-foreground"
            title={pendingMigrateDir ?? ''}
          >
            {pendingMigrateDir}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={migrate}>
              {t('models.migrateDialog.action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {migrating && migrationProgress && <MigrationOverlay progress={migrationProgress} />}
    </>
  );
}

/** Covers the app while the server is offline moving models. */
function MigrationOverlay({ progress }: { progress: MigrationProgress }) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm">
      <div className="w-full max-w-md space-y-6 px-8 text-center">
        <div className="space-y-2">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-accent" />
          <h2 className="text-lg font-semibold">{t('models.migrate.title')}</h2>
          <p className="text-[13px] text-muted-foreground">
            {progress.status === 'complete'
              ? t('models.migrateDialog.restartingServer')
              : t('models.migrate.offline')}
          </p>
        </div>
        {progress.total > 0 && (
          <div className="space-y-2">
            <Progress value={progress.progress} className="h-1" />
            <div className="flex justify-between gap-4 font-mono text-[11px] text-muted-foreground">
              <span className="truncate">{progress.filename}</span>
              <span className="shrink-0">
                {formatBytes(progress.current)} / {formatBytes(progress.total)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
