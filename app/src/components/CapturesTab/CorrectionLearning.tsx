import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { WritingStyleHabits } from '@/components/WritingStyle/WritingStyleHabits';
import { apiClient } from '@/lib/api/client';
import type { CaptureFeedbackResponse } from '@/lib/api/types';
import { useWritingStyle } from '@/lib/hooks/useWritingStyle';

const queryKey = ['correction-learning'];

export function CorrectionLearning({
  reports,
}: {
  reports: Pick<CaptureFeedbackResponse, 'id'>[];
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const writingStyle = useWritingStyle();
  const status = useQuery({
    queryKey,
    queryFn: () => apiClient.correctionLearningStatus(),
    refetchInterval: (query) => (query.state.data?.model?.running ? 2000 : 60_000),
    enabled: reports.length > 0,
  });
  const action = useMutation({
    mutationFn: async (kind: 'run' | 'rollback' | 'cancel') => {
      if (kind === 'cancel') {
        await apiClient.cancelModelLearning();
        return apiClient.correctionLearningStatus();
      }
      return kind === 'run'
        ? apiClient.runCorrectionLearning()
        : apiClient.rollbackCorrectionLearning();
    },
    onSuccess: (data) => queryClient.setQueryData(queryKey, data),
  });

  if (!reports.some((report) => status.data?.evaluated_report_ids?.includes(report.id))) {
    return null;
  }

  return (
    <details className="text-[13px] rounded-md border border-border bg-card p-3">
      <summary className="cursor-pointer font-mono text-[11px] uppercase text-muted-foreground hover:text-foreground">
        {t('captures.feedback.learning.title')}
      </summary>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {t('captures.feedback.learning.description')}
      </p>
      {writingStyle.data?.habits.length ? (
        <div className="mt-2 space-y-1">
          <p className="font-medium">{t('writingStyle.learningPanel.title')}</p>
          <WritingStyleHabits habits={writingStyle.data.habits} />
        </div>
      ) : null}
      {status.data && (
        <div className="mt-2 space-y-1">
          <p>{t('captures.feedback.learning.active', { count: status.data.active_rules })}</p>
          <p>{t(`captures.feedback.learning.${status.data.outcome}`)}</p>
          {status.data.last_run && (
            <p className="text-muted-foreground">
              {t('captures.feedback.learning.lastRun', {
                date: new Date(status.data.last_run).toLocaleString(),
              })}
            </p>
          )}
          {status.data.metrics && !status.data.metrics.latency_passed && (
            <p>{t('captures.feedback.learning.tooSlow')}</p>
          )}
        </div>
      )}
      {(status.isError || action.isError) && (
        <p role="alert" className="mt-2 text-destructive">
          {t('captures.feedback.learning.failed')}
        </p>
      )}
      {status.data?.model && (
        <div className="mt-3 space-y-1 border-t border-border pt-3">
          <p className="font-medium">{t('captures.feedback.learning.modelTitle')}</p>
          <p>{t(`captures.feedback.learning.modelPhases.${status.data.model.phase}`)}</p>
          <p className="text-muted-foreground">
            {t('captures.feedback.learning.dataset', {
              train: status.data.model.counts.train ?? 0,
              validation: status.data.model.counts.validation ?? 0,
              test: status.data.model.counts.audio_test ?? 0,
            })}
          </p>
          <p>
            {t(
              status.data.model.active_adapter
                ? 'captures.feedback.learning.personalModel'
                : 'captures.feedback.learning.baseModel',
            )}
          </p>
          {status.data.model.speech_model && (
            <p>
              {t('captures.feedback.learning.speechModel', {
                model: status.data.model.speech_model,
              })}
            </p>
          )}
          {status.data.model.metrics?.adapter && (
            <p>
              {t('captures.feedback.learning.evaluation', {
                before: status.data.model.metrics.adapter.baseline_errors,
                after: status.data.model.metrics.adapter.candidate_errors,
              })}
            </p>
          )}
          {status.data.model.error && (
            <p role="alert" className="text-destructive">
              {status.data.model.error}
            </p>
          )}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={action.isPending || status.data?.model?.running}
          onClick={() => action.mutate('run')}
        >
          {t(
            action.isPending
              ? 'captures.feedback.learning.running'
              : 'captures.feedback.learning.run',
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={
            action.isPending || !(status.data?.can_rollback || status.data?.model?.can_rollback)
          }
          onClick={() => action.mutate('rollback')}
        >
          {t(
            status.data?.model?.can_rollback
              ? 'captures.feedback.learning.rollbackModel'
              : 'captures.feedback.learning.rollback',
          )}
        </Button>
        {status.data?.model?.running && (
          <Button
            size="sm"
            variant="ghost"
            disabled={action.isPending}
            onClick={() => action.mutate('cancel')}
          >
            {t('captures.feedback.learning.cancelTraining')}
          </Button>
        )}
      </div>
    </details>
  );
}
