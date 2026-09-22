import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { WritingStyleCalibrationResult, WritingStyleCalibrationStep } from '@/lib/api/types';
import { WRITING_STYLE_KEY } from '@/lib/hooks/useWritingStyle';
import { useCaptureSettings } from '@/lib/hooks/useSettings';
import { PERSONAL_EXAMPLES_KEY } from './PersonalExamples';
import { WritingStyleHabits } from './WritingStyleHabits';

/** What calibration learns from; each has a line on the start screen. */
const CALIBRATION_CHANGES = ['falseStarts', 'order', 'grammar', 'punctuation'] as const;

/** A later paragraph that still needed this much change means another run will help. */
const SETTLED_CHANGE = 0.1;

type Stage =
  | { kind: 'intro' }
  | { kind: 'step'; step: WritingStyleCalibrationStep }
  | { kind: 'summary'; changes: number[]; result: WritingStyleCalibrationResult };

/**
 * Five paragraphs, one at a time: the user rewrites each the way they would
 * type it, and the next arrives already styled with what Voicebox learned.
 */
export function StyleCalibrationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { settings, update } = useCaptureSettings();
  const [stage, setStage] = useState<Stage>({ kind: 'intro' });
  const [draft, setDraft] = useState('');
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (open) setStage({ kind: 'intro' });
  }, [open]);

  const fail = (error: Error) =>
    toast({
      title: t('writingStyle.calibration.failed'),
      description: error.message,
      variant: 'destructive',
    });

  const showStep = (step: WritingStyleCalibrationStep) => {
    sessionRef.current = step.session_id;
    setDraft(step.paragraph ?? '');
    setStage({ kind: 'step', step });
  };

  const start = useMutation({
    mutationFn: () => apiClient.startStyleCalibration(),
    onSuccess: showStep,
    onError: fail,
  });

  const finish = useMutation({
    mutationFn: (sessionId: string) => apiClient.finishStyleCalibration(sessionId),
    onError: fail,
  });

  const submit = useMutation({
    mutationFn: ({ sessionId, written }: { sessionId: string; written: string }) =>
      apiClient.submitStyleCalibrationStep(sessionId, written),
    onSuccess: async (step) => {
      if (!step.done) {
        showStep(step);
        return;
      }
      const result = await finish.mutateAsync(step.session_id);
      sessionRef.current = null;
      queryClient.setQueryData(WRITING_STYLE_KEY, result.status);
      queryClient.invalidateQueries({ queryKey: PERSONAL_EXAMPLES_KEY });
      setStage({ kind: 'summary', changes: step.changes, result });
    },
    onError: fail,
  });

  const close = () => {
    // Leaving midway keeps nothing from this run.
    if (sessionRef.current) {
      void apiClient.discardStyleCalibration(sessionRef.current).catch(() => undefined);
      sessionRef.current = null;
    }
    onOpenChange(false);
  };

  const busy = start.isPending || submit.isPending || finish.isPending;
  const switchToLearned = () => {
    update({ punctuation_style: 'learned' });
    close();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-xl">
        {stage.kind === 'intro' && (
          <>
            <DialogHeader>
              <DialogTitle>{t('writingStyle.calibration.title')}</DialogTitle>
              <DialogDescription>{t('writingStyle.calibration.intro')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2 text-sm">
              <p className="font-medium">{t('writingStyle.calibration.changesTitle')}</p>
              <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
                {CALIBRATION_CHANGES.map((change) => (
                  <li key={change}>{t(`writingStyle.calibration.changes.${change}`)}</li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                {t('writingStyle.calibration.wordsNote')}
              </p>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={close}>
                {t('writingStyle.calibration.notNow')}
              </Button>
              <Button onClick={() => start.mutate()} disabled={busy}>
                {start.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t('writingStyle.calibration.start')}
              </Button>
            </DialogFooter>
          </>
        )}

        {stage.kind === 'step' && (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('writingStyle.calibration.progress', {
                  current: stage.step.step + 1,
                  total: stage.step.total,
                })}
              </DialogTitle>
              <DialogDescription>{t('writingStyle.calibration.instructions')}</DialogDescription>
            </DialogHeader>
            {stage.step.said && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('writingStyle.calibration.said')}
                </p>
                <p className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
                  {stage.step.said}
                </p>
              </div>
            )}
            <div className="space-y-1">
              <label
                htmlFor="calibration-draft"
                className="text-xs font-medium text-muted-foreground"
              >
                {t('writingStyle.calibration.paragraphLabel')}
              </label>
              <Textarea
                id="calibration-draft"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={busy}
                className="min-h-[140px] text-sm leading-relaxed"
                autoFocus
              />
              {submit.isPending && (
                <p className="text-xs text-muted-foreground">
                  {t('writingStyle.calibration.cleaning')}
                </p>
              )}
            </div>
            {stage.step.habits.length > 0 && (
              <div className="text-xs text-muted-foreground space-y-1">
                <p className="font-medium">{t('writingStyle.calibration.pickedUp')}</p>
                <WritingStyleHabits habits={stage.step.habits} />
              </div>
            )}
            <DialogFooter>
              {/* Submits the box as it stands, edited or not. */}
              <Button
                disabled={busy || !draft.trim()}
                onClick={() => submit.mutate({ sessionId: stage.step.session_id, written: draft })}
              >
                {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t('writingStyle.calibration.looksLikeMe')}
              </Button>
            </DialogFooter>
          </>
        )}

        {stage.kind === 'summary' && (
          <>
            <DialogHeader>
              <DialogTitle>{t('writingStyle.summary.title')}</DialogTitle>
              <DialogDescription>
                {stage.changes.slice(-2).some((change) => change > SETTLED_CHANGE)
                  ? t('writingStyle.summary.runAgain')
                  : t('writingStyle.summary.settled')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              <p>{t('writingStyle.summary.examplesSaved')}</p>
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('writingStyle.summary.habitsTitle')}
                </p>
                {stage.result.status.habits.length > 0 ? (
                  <WritingStyleHabits habits={stage.result.status.habits} />
                ) : (
                  <p className="text-muted-foreground">{t('writingStyle.summary.noHabits')}</p>
                )}
              </div>
              {stage.result.before !== stage.result.after && (
                <div className="grid gap-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('writingStyle.summary.before')}
                  </p>
                  <p className="rounded-md border p-3 text-muted-foreground">
                    {stage.result.before}
                  </p>
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('writingStyle.summary.after')}
                  </p>
                  <p className="rounded-md border border-accent/40 p-3">{stage.result.after}</p>
                </div>
              )}
            </div>
            <DialogFooter>
              {settings?.punctuation_style === 'learned' ? (
                <Button onClick={close}>{t('writingStyle.summary.done')}</Button>
              ) : (
                <>
                  <Button variant="ghost" onClick={close}>
                    {t('writingStyle.summary.keepCurrent')}
                  </Button>
                  <Button onClick={switchToLearned}>{t('writingStyle.summary.useLearned')}</Button>
                </>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
