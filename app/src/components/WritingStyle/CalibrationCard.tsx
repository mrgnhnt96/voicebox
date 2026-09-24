import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useWritingStyle } from '@/lib/hooks/useWritingStyle';
import { StyleCalibrationDialog } from './StyleCalibrationDialog';
import { WritingStyleHabitChips } from './WritingStyleHabits';

/** The invitation to calibrate, with what the last runs learned. */
export function CalibrationCard() {
  const { t } = useTranslation();
  const { data: status } = useWritingStyle();
  const [open, setOpen] = useState(false);
  const runs = status?.runs ?? 0;

  return (
    <section className="mb-7 flex flex-col gap-3.5 rounded-[10px] border border-accent/20 bg-accent/[0.04] p-5">
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{t('writingStyle.settings.calibrate.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {t('writingStyle.settings.calibrate.description')}
          </p>
        </div>
        <Button className="shrink-0 font-semibold" onClick={() => setOpen(true)}>
          {runs
            ? t('writingStyle.settings.calibrate.again')
            : t('writingStyle.settings.calibrate.start')}
        </Button>
      </div>

      {runs > 0 && (
        <>
          <p className="font-mono text-[11px] text-muted-foreground">
            <span className="uppercase">{t('writingStyle.settings.calibrate.habitsLabel')}</span>
            {status?.last_run_at &&
              ` · ${t('writingStyle.settings.calibrate.lastRun', {
                date: new Date(status.last_run_at).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                }),
                count: runs,
              })}`}
          </p>
          {status?.habits.length ? (
            <WritingStyleHabitChips habits={status.habits} />
          ) : (
            <p className="text-xs text-muted-foreground">{t('writingStyle.summary.noHabits')}</p>
          )}
        </>
      )}

      <StyleCalibrationDialog open={open} onOpenChange={setOpen} />
    </section>
  );
}
