import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { ActiveDownloadTask } from '@/lib/api/types';
import type { DictationReadiness } from '@/lib/hooks/useDictationReadiness';

export type ModelGate = 'stt' | 'llm';

export interface ModelDownloads {
  /** In-flight downloads keyed by model name. */
  downloadByModel: Map<string, ActiveDownloadTask>;
  download: (gate: ModelGate, modelName: string) => void;
  /** A download request is on its way to the server. */
  isStarting: boolean;
}

/** Download percentage for a task, or null when the server hasn't sized it yet. */
export function progressPercent(task: ActiveDownloadTask | undefined): number | null {
  if (!task) return null;
  if (typeof task.progress === 'number')
    return Math.round(Math.max(0, Math.min(100, task.progress)));
  if (task.current && task.total) return Math.round((task.current / task.total) * 100);
  return null;
}

/**
 * Download state for the dictation models, plus a trigger to start one.
 *
 * In-flight downloads come from ``/tasks/active`` (the same query the Models
 * page uses) so progress survives unmount: leaving the screen and coming
 * back still shows the running download instead of a fresh button.
 */
export function useModelDownloads(readiness: DictationReadiness): ModelDownloads {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: activeTasks } = useQuery({
    queryKey: ['activeTasks'],
    queryFn: () => apiClient.getActiveTasks(),
    // Mirror ModelManagement's cadence: 1s while a download is in flight,
    // 5s otherwise. Keeps progress feeling live without hammering when idle.
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasActive = data?.downloads.some((d) => d.status === 'downloading');
      return hasActive ? 1000 : 5000;
    },
  });

  // Memo so the Map identity is stable across renders that don't change
  // activeTasks, otherwise the effect below re-fires on every poll tick.
  const downloadByModel = useMemo(() => {
    const m = new Map<string, ActiveDownloadTask>();
    for (const dl of activeTasks?.downloads ?? []) {
      if (dl.status === 'downloading') m.set(dl.model_name, dl);
    }
    return m;
  }, [activeTasks]);

  // A download that drops out of activeTasks just finished. Refetch
  // readiness now so the model flips to done without waiting for the poll.
  const prevActive = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(downloadByModel.keys());
    for (const name of prevActive.current) {
      if (!current.has(name)) {
        queryClient.invalidateQueries({ queryKey: ['capture-readiness'] });
        queryClient.invalidateQueries({ queryKey: ['modelStatus'] });
        break;
      }
    }
    prevActive.current = current;
  }, [downloadByModel, queryClient]);

  const mutation = useMutation({
    mutationFn: async ({ modelName }: { gate: ModelGate; modelName: string }) =>
      apiClient.triggerModelDownload(modelName),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['activeTasks'] });
      queryClient.invalidateQueries({ queryKey: ['modelStatus'] });
      queryClient.invalidateQueries({ queryKey: ['capture-readiness'] });
      const displayName =
        vars.gate === 'stt' ? readiness.stt?.display_name : readiness.llm?.display_name;
      toast({
        title: t('captures.readiness.downloadStarted'),
        description: t('captures.readiness.downloadStartedDescription', { name: displayName }),
      });
    },
    onError: (err: Error) => {
      toast({
        title: t('captures.readiness.downloadFailed'),
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  return {
    downloadByModel,
    download: (gate: ModelGate, modelName: string) => mutation.mutate({ gate, modelName }),
    isStarting: mutation.isPending,
  };
}
