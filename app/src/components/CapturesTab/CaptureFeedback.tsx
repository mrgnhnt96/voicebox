import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { CaptureResponse } from '@/lib/api/types';
import { usePlatform } from '@/platform/PlatformContext';
import { CorrectionLearning } from './CorrectionLearning';

/**
 * Below the transcripts: what teaching does, this capture's saved
 * corrections, the export of every correction, and the learning job's status.
 * Corrections themselves are made inline in the transcript panels.
 */
export function CaptureFeedback({ capture }: { capture: CaptureResponse }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const platform = usePlatform();
  const reports = useQuery({
    queryKey: ['capture-feedback', capture.id],
    queryFn: () => apiClient.listCaptureFeedback(capture.id),
  });
  const exportMutation = useMutation({
    mutationFn: async () => {
      const reports = await apiClient.exportCaptureFeedback();
      await platform.filesystem.saveFile(
        'capture-corrections.json',
        new Blob([JSON.stringify({ schema_version: 1, reports }, null, 2)], {
          type: 'application/json',
        }),
        [{ name: 'JSON', extensions: ['json'] }],
      );
    },
    onError: (error: Error) =>
      toast({
        title: t('captures.feedback.exportFailed'),
        description: error.message,
        variant: 'destructive',
      }),
  });

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-mono text-[11px] uppercase text-muted-foreground">
          {t('captures.feedback.sectionTitle')}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground"
          disabled={exportMutation.isPending}
          onClick={() => exportMutation.mutate()}
        >
          {t('captures.feedback.export')}
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t('captures.feedback.description')}
      </p>
      {reports.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t('captures.feedback.loadFailed')}
        </p>
      )}
      <CorrectionLearning reports={reports.data ?? []} />
      {!!reports.data?.length && (
        <details className="group text-[13px]">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            {t('captures.feedback.history', { count: reports.data.length })}
          </summary>
          <ul className="mt-2 divide-y divide-border/70 rounded-md border border-border bg-card">
            {reports.data.map((report) => (
              <li key={report.id} className="p-3 space-y-1.5">
                <p className="font-mono text-[11px] text-muted-foreground">
                  {t(`captures.transcript.${report.target}`)} ·{' '}
                  {new Date(report.created_at).toLocaleString()}
                </p>
                <p className="whitespace-pre-wrap">{report.expected_text || '∅'}</p>
                {report.notes && (
                  <p className="text-muted-foreground whitespace-pre-wrap">{report.notes}</p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
