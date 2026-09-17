import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { CaptureFeedbackCreate, CaptureResponse } from '@/lib/api/types';
import { usePlatform } from '@/platform/PlatformContext';
import { CorrectionLearning } from './CorrectionLearning';

export function CaptureFeedback({
  capture,
  target,
}: {
  capture: CaptureResponse;
  target: 'raw' | 'refined';
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const platform = usePlatform();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<CaptureFeedbackCreate | null>(null);
  const queryKey = ['capture-feedback', capture.id];
  const reports = useQuery({ queryKey, queryFn: () => apiClient.listCaptureFeedback(capture.id) });
  const mutation = useMutation({
    mutationFn: (body: CaptureFeedbackCreate) =>
      apiClient.reportCaptureOutput(body.snapshot.id, body),
    onSuccess: () => {
      setDraft(null);
      queryClient.invalidateQueries({ queryKey });
      toast({ title: t('captures.feedback.saved') });
    },
    onError: (error: Error) =>
      toast({
        title: t('captures.feedback.failed'),
        description: error.message,
        variant: 'destructive',
      }),
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
  const original =
    draft?.target === 'refined'
      ? draft.snapshot.transcript_refined
      : draft?.snapshot.transcript_raw;

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setDraft({
              snapshot: capture,
              target,
              expected_text:
                (target === 'refined' ? capture.transcript_refined : capture.transcript_raw) ?? '',
              notes: '',
            })
          }
        >
          {t('captures.feedback.report')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={exportMutation.isPending}
          onClick={() => exportMutation.mutate()}
        >
          {t('captures.feedback.export')}
        </Button>
      </div>
      {reports.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t('captures.feedback.loadFailed')}
        </p>
      )}
      <CorrectionLearning reports={reports.data ?? []} />
      {!!reports.data?.length && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {t('captures.feedback.history', { count: reports.data.length })}
          </summary>
          {reports.data.map((report) => (
            <div key={report.id} className="mt-2 rounded-md border p-3 space-y-2">
              <p className="text-xs text-muted-foreground">
                {t(`captures.transcript.${report.target}`)} ·{' '}
                {new Date(report.created_at).toLocaleString()}
              </p>
              <p className="whitespace-pre-wrap">{report.expected_text || '∅'}</p>
              {report.notes && (
                <p className="text-muted-foreground whitespace-pre-wrap">{report.notes}</p>
              )}
            </div>
          ))}
        </details>
      )}
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setDraft(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('captures.feedback.report')}</DialogTitle>
            <DialogDescription>{t('captures.feedback.description')}</DialogDescription>
          </DialogHeader>
          {draft && (
            <>
              <Label htmlFor="feedback-original">
                {t('captures.feedback.original', {
                  target: t(`captures.transcript.${draft.target}`),
                })}
              </Label>
              <Textarea id="feedback-original" value={original ?? ''} readOnly />
              <Label htmlFor="feedback-expected">{t('captures.feedback.expected')}</Label>
              <Textarea
                id="feedback-expected"
                value={draft.expected_text}
                maxLength={100000}
                disabled={mutation.isPending}
                onChange={(event) => setDraft({ ...draft, expected_text: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t('captures.feedback.emptyHint')}</p>
              <Label htmlFor="feedback-notes">{t('captures.feedback.notes')}</Label>
              <Textarea
                id="feedback-notes"
                value={draft.notes}
                maxLength={5000}
                disabled={mutation.isPending}
                onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
              />
              <DialogFooter>
                <Button
                  variant="ghost"
                  disabled={mutation.isPending}
                  onClick={() => setDraft(null)}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  disabled={
                    mutation.isPending || draft.expected_text.trim() === (original ?? '').trim()
                  }
                  onClick={() => mutation.mutate(draft)}
                >
                  {t('captures.feedback.save')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
