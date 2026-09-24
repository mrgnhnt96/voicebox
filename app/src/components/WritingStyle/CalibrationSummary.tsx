import { Check, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { WritingStyleCalibrationResult } from '@/lib/api/types';

/** A later paragraph that still needed this much change means another run will help. */
const SETTLED_CHANGE = 0.1;

/** The end of calibration: what was learned, and whether to follow it. */
export function CalibrationSummary({
  changes,
  result,
  learnedStyleOn,
  restarting,
  onRunAgain,
  onUseLearned,
  onClose,
}: {
  /** Share of each paragraph the user changed, 0 to 1. */
  changes: number[];
  result: WritingStyleCalibrationResult;
  learnedStyleOn: boolean;
  restarting: boolean;
  onRunAgain: () => void;
  onUseLearned: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const habits = result.status.habits;
  const edited = changes.filter((change) => change > 0).length;

  return (
    <>
      <div className="flex flex-col gap-2 border-b border-border px-7 pt-6 pb-[18px]">
        <p className="flex items-center gap-2 font-mono text-xs text-success">
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
          {t('writingStyle.summary.progress', { total: changes.length, edited })}
        </p>
        <DialogTitle className="text-xl">{t('writingStyle.summary.title')}</DialogTitle>
        <DialogDescription className="text-[13px] leading-normal">
          {changes.slice(-2).some((change) => change > SETTLED_CHANGE)
            ? t('writingStyle.summary.runAgain')
            : t('writingStyle.summary.settled')}{' '}
          {t('writingStyle.summary.examplesSaved')}
        </DialogDescription>
      </div>

      <div className="px-7 py-2">
        <p className="pt-3 pb-1 font-mono text-[11px] uppercase text-muted-foreground">
          {t('writingStyle.summary.habitsTitle')}
        </p>
        {habits.length > 0 ? (
          <ul>
            {habits.map((habit) => (
              <li key={habit} className="border-b border-border/70 py-3.5 last:border-b-0">
                <p className="text-sm">{t(`writingStyle.habits.${habit}`)}</p>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {t(`writingStyle.habitChips.${habit}`)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-3 text-[13px] text-muted-foreground">
            {t('writingStyle.summary.noHabits')}
          </p>
        )}
      </div>

      {result.before !== result.after && (
        <div className="grid grid-cols-2 gap-4 px-7 pt-2 pb-5 text-[13px]">
          <div className="space-y-2">
            <p className="font-mono text-[11px] uppercase text-muted-foreground">
              {t('writingStyle.summary.before')}
            </p>
            <p className="rounded-lg border border-border bg-card p-3 text-muted-foreground">
              {result.before}
            </p>
          </div>
          <div className="space-y-2">
            <p className="font-mono text-[11px] uppercase text-accent">
              {t('writingStyle.summary.after')}
            </p>
            <p className="rounded-lg border border-accent/30 bg-accent/[0.04] p-3">
              {result.after}
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-border px-7 py-4">
        <Button
          variant="ghost"
          className="text-muted-foreground"
          disabled={restarting}
          onClick={onRunAgain}
        >
          {restarting && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('writingStyle.summary.runItAgain')}
        </Button>
        <span className="flex-1" />
        {learnedStyleOn ? (
          <Button className="px-[18px] font-semibold" onClick={onClose}>
            {t('writingStyle.summary.done')}
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              {t('writingStyle.summary.keepCurrent')}
            </Button>
            <Button className="font-semibold" onClick={onUseLearned}>
              {t('writingStyle.summary.useLearned')}
            </Button>
          </>
        )}
      </div>
    </>
  );
}
