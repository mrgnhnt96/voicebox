import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { ActiveDownloadTask, ModelStatus } from '@/lib/api/types';
import { useModelDownloadToast } from '@/lib/hooks/useModelDownloadToast';

export interface ModelDownloadState {
  isDownloading: boolean;
  hasError: boolean;
  /** Live progress for an in-flight download, when the server reports it. */
  progress?: ActiveDownloadTask;
  /** The failed download, when there is one. */
  error?: ActiveDownloadTask;
}

/**
 * Download, cancel and error tracking for the Models screen. Merges the
 * server's active tasks with errors reported by the progress stream, and
 * lets the user dismiss errors without touching the server.
 */
export function useModelDownloads(models: ModelStatus[] | undefined) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadingDisplayName, setDownloadingDisplayName] = useState<string | null>(null);
  const [dismissedErrors, setDismissedErrors] = useState<Set<string>>(new Set());
  const [localErrors, setLocalErrors] = useState<Map<string, string>>(new Map());

  const { data: activeTasks } = useQuery({
    queryKey: ['activeTasks'],
    queryFn: () => apiClient.getActiveTasks(),
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasActive = data?.downloads.some((d) => d.status === 'downloading');
      return hasActive ? 1000 : 5000;
    },
  });

  // Errored downloads, excluding dismissed ones. Errors from the progress
  // stream carry more detail than the task list, so they win.
  const erroredDownloads = useMemo(() => {
    const errored = new Map<string, ActiveDownloadTask>();
    for (const dl of activeTasks?.downloads ?? []) {
      if (dl.status === 'error' && !dismissedErrors.has(dl.model_name)) {
        const localErr = localErrors.get(dl.model_name);
        errored.set(dl.model_name, localErr ? { ...dl, error: localErr } : dl);
      }
    }
    for (const [modelName, error] of localErrors) {
      if (!errored.has(modelName) && !dismissedErrors.has(modelName)) {
        errored.set(modelName, {
          model_name: modelName,
          status: 'error',
          started_at: new Date().toISOString(),
          error,
        });
      }
    }
    return errored;
  }, [activeTasks, dismissedErrors, localErrors]);

  const progressMap = useMemo(() => {
    const map = new Map<string, ActiveDownloadTask>();
    for (const dl of activeTasks?.downloads ?? []) {
      if (dl.status === 'downloading') map.set(dl.model_name, dl);
    }
    return map;
  }, [activeTasks]);

  const handleDownloadComplete = useCallback(() => {
    setDownloadingModel(null);
    setDownloadingDisplayName(null);
    queryClient.invalidateQueries({ queryKey: ['modelStatus'] });
    queryClient.invalidateQueries({ queryKey: ['activeTasks'] });
  }, [queryClient]);

  const handleDownloadError = useCallback(
    (error: string) => {
      if (downloadingModel) {
        setLocalErrors((prev) => new Map(prev).set(downloadingModel, error));
      }
      setDownloadingModel(null);
      setDownloadingDisplayName(null);
      queryClient.invalidateQueries({ queryKey: ['activeTasks'] });
    },
    [queryClient, downloadingModel],
  );

  useModelDownloadToast({
    modelName: downloadingModel || '',
    displayName: downloadingDisplayName || '',
    enabled: !!downloadingModel && !!downloadingDisplayName,
    onComplete: handleDownloadComplete,
    onError: handleDownloadError,
  });

  const download = async (modelName: string) => {
    setDismissedErrors((prev) => {
      const next = new Set(prev);
      next.delete(modelName);
      return next;
    });

    const model = models?.find((m) => m.model_name === modelName);
    const displayName = model?.display_name || modelName;

    try {
      await apiClient.triggerModelDownload(modelName);

      setDownloadingModel(modelName);
      setDownloadingDisplayName(displayName);

      queryClient.invalidateQueries({ queryKey: ['modelStatus'] });
      queryClient.invalidateQueries({ queryKey: ['activeTasks'] });
    } catch (error) {
      setDownloadingModel(null);
      setDownloadingDisplayName(null);
      toast({
        title: t('models.toast.downloadFailed'),
        description: error instanceof Error ? error.message : t('common.unknownError'),
        variant: 'destructive',
      });
    }
  };

  const cancelMutation = useMutation({
    mutationFn: (modelName: string) => apiClient.cancelDownload(modelName),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['modelStatus'], refetchType: 'all' });
      await queryClient.invalidateQueries({ queryKey: ['activeTasks'], refetchType: 'all' });
    },
  });

  /** Cancel an in-flight download, or dismiss a failed one. */
  const cancel = (modelName: string) => {
    const prevDismissed = dismissedErrors;
    const prevLocalErrors = localErrors;
    const prevDownloadingModel = downloadingModel;
    const prevDownloadingDisplayName = downloadingDisplayName;

    setDismissedErrors((prev) => new Set(prev).add(modelName));
    setLocalErrors((prev) => {
      const next = new Map(prev);
      next.delete(modelName);
      return next;
    });
    if (downloadingModel === modelName) {
      setDownloadingModel(null);
      setDownloadingDisplayName(null);
    }

    cancelMutation.mutate(modelName, {
      onError: () => {
        setDismissedErrors(prevDismissed);
        setLocalErrors(prevLocalErrors);
        setDownloadingModel(prevDownloadingModel);
        setDownloadingDisplayName(prevDownloadingDisplayName);
        toast({
          title: t('models.toast.cancelFailed'),
          description: t('models.toast.cancelFailedDescription'),
          variant: 'destructive',
        });
      },
    });
  };

  const clearAllMutation = useMutation({
    mutationFn: () => apiClient.clearAllTasks(),
    onSuccess: async () => {
      setDismissedErrors(new Set());
      setLocalErrors(new Map());
      setDownloadingModel(null);
      setDownloadingDisplayName(null);
      await queryClient.invalidateQueries({ queryKey: ['modelStatus'], refetchType: 'all' });
      await queryClient.invalidateQueries({ queryKey: ['activeTasks'], refetchType: 'all' });
    },
  });

  const stateOf = (model: ModelStatus): ModelDownloadState => {
    const error = erroredDownloads.get(model.model_name);
    const isDownloading =
      (model.downloading || downloadingModel === model.model_name) &&
      !error &&
      !dismissedErrors.has(model.model_name);
    return {
      isDownloading,
      hasError: !!error,
      progress: progressMap.get(model.model_name),
      error,
    };
  };

  return {
    erroredDownloads,
    stateOf,
    download,
    cancel,
    isCancelling: (modelName: string) =>
      cancelMutation.isPending && cancelMutation.variables === modelName,
    clearAll: () => clearAllMutation.mutate(),
    isClearingAll: clearAllMutation.isPending,
  };
}

/** Download percent (0-100), or null while the total size is unknown. */
export function downloadPercent(progress: ActiveDownloadTask | undefined): number | null {
  if (!progress?.total || progress.total <= 0) return null;
  return progress.progress ?? 0;
}
