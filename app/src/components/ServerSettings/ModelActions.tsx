import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
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
import { Button, buttonVariants } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { ModelStatus } from '@/lib/api/types';
import { usePlatform } from '@/platform/PlatformContext';
import { formatSizeMb, hfCacheFolder } from './modelCatalog';
import type { ModelDownloadState } from './useModelDownloads';

interface ModelActionsProps {
  model: ModelStatus;
  state: ModelDownloadState;
  /** The Hugging Face cache folder, when the desktop app knows it. */
  cacheDir: string | undefined;
  onDownload: () => void;
  /** Cancels an in-flight download or dismisses a failed one. */
  onCancel: () => void;
  cancelling: boolean;
}

/** The bottom action bar of the model detail pane. */
export function ModelActions({
  model,
  state,
  cacheDir,
  onDownload,
  onCancel,
  cancelling,
}: ModelActionsProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const platform = usePlatform();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: (modelName: string) => apiClient.deleteModel(modelName),
    onSuccess: async () => {
      toast({
        title: t('models.toast.deleted'),
        description: t('models.toast.deletedDescription', { name: model.display_name }),
      });
      setDeleteOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['modelStatus'], refetchType: 'all' });
      await queryClient.refetchQueries({ queryKey: ['modelStatus'] });
    },
    onError: (error: Error) => {
      toast({
        title: t('models.toast.deleteFailed'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const unloadMutation = useMutation({
    mutationFn: (modelName: string) => apiClient.unloadModel(modelName),
    onSuccess: async (_data, modelName) => {
      toast({
        title: t('models.toast.unloaded'),
        description: t('models.toast.unloadedDescription', { name: modelName }),
      });
      await queryClient.invalidateQueries({ queryKey: ['modelStatus'], refetchType: 'all' });
      await queryClient.refetchQueries({ queryKey: ['modelStatus'] });
    },
    onError: (error: Error) => {
      toast({
        title: t('models.toast.unloadFailed'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const showInFinder = async () => {
    if (!cacheDir || !model.hf_repo_id) return;
    try {
      await platform.filesystem.openPath(hfCacheFolder(cacheDir, model.hf_repo_id));
    } catch {
      toast({ title: t('models.toast.openFolderFailed'), variant: 'destructive' });
    }
  };

  let actions: ReactNode;
  if (state.hasError) {
    actions = (
      <>
        <Button onClick={onDownload}>{t('models.actions.retry')}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={cancelling}>
          {t('models.actions.dismiss')}
        </Button>
      </>
    );
  } else if (state.isDownloading) {
    actions = (
      <Button variant="outline" onClick={onCancel} disabled={cancelling}>
        {t('models.actions.cancelDownload')}
      </Button>
    );
  } else if (model.downloaded) {
    actions = (
      <>
        {model.loaded && (
          <Button
            variant="secondary"
            onClick={() => unloadMutation.mutate(model.model_name)}
            disabled={unloadMutation.isPending}
          >
            {unloadMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {unloadMutation.isPending
              ? t('models.actions.unloading')
              : t('models.actions.unloadFromMemory')}
          </Button>
        )}
        {platform.metadata.isTauri && cacheDir && model.hf_repo_id && (
          <Button variant="outline" onClick={showInFinder}>
            {t('models.actions.showInFinder')}
          </Button>
        )}
        <span className="flex-1" />
        <Button
          variant="ghost"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setDeleteOpen(true)}
          disabled={model.loaded}
          title={model.loaded ? t('models.actions.unloadFirst') : undefined}
        >
          {t('models.actions.deleteModel')}
        </Button>
      </>
    );
  } else {
    actions = <Button onClick={onDownload}>{t('models.actions.download')}</Button>;
  }

  return (
    <div className="flex h-16 shrink-0 items-center gap-2 border-t border-border px-8">
      {actions}

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('models.deleteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              <Trans
                i18nKey="models.deleteDialog.body"
                values={{ name: model.display_name }}
                components={{ strong: <strong /> }}
              />
              {model.size_mb && (
                <> {t('models.deleteDialog.sizeNote', { size: formatSizeMb(model.size_mb) })}</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Keep the dialog open until the delete settles.
                e.preventDefault();
                deleteMutation.mutate(model.model_name);
              }}
              disabled={deleteMutation.isPending}
              className={buttonVariants({ variant: 'destructive' })}
            >
              {deleteMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('models.deleteDialog.deleting')}
                </>
              ) : (
                t('common.delete')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
