import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@/lib/api/client';
import type { CaptureResponse } from '@/lib/api/types';
import { CorrectionLearning } from './CorrectionLearning';

/**
 * Below the transcripts: this capture's saved corrections and the learning
 * job's status. Corrections are made in the transcript panels, where the ?
 * beside Alter explains them; exporting every correction is in Settings,
 * Writing style.
 */
export function CaptureFeedback({ capture }: { capture: CaptureResponse }) {
  const { t } = useTranslation();
  const reports = useQuery({
    queryKey: ['capture-feedback', capture.id],
    queryFn: () => apiClient.listCaptureFeedback(capture.id),
  });

  // Nothing to show until this capture has a correction.
  if (!reports.isError && !reports.data?.length) return null;

  return (
    <section className="space-y-3">
      <h3 className="font-mono text-[11px] uppercase text-muted-foreground">
        {t('captures.feedback.sectionTitle')}
      </h3>
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
