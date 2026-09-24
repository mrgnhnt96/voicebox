import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import type { WritingStyleCalibrationStep } from '@/lib/api/types';
import { cn } from '@/lib/utils/cn';

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * One calibration paragraph: Voicebox's cleanup on the left, the user's
 * rewrite on the right, with a running note of what changed.
 */
export function CalibrationStepView({
  step,
  draft,
  onDraftChange,
  busy,
  submitting,
  onSubmit,
}: {
  step: WritingStyleCalibrationStep;
  draft: string;
  onDraftChange: (draft: string) => void;
  busy: boolean;
  submitting: boolean;
  onSubmit: (written: string) => void;
}) {
  const { t } = useTranslation();
  const original = step.paragraph ?? '';
  const canSave = !busy && draft.trim().length > 0;
  const wordDelta = wordCount(draft) - wordCount(original);
  const isLast = step.step + 1 >= step.total;

  const save = () => {
    if (canSave) onSubmit(draft);
  };

  return (
    <>
      <div className="flex flex-col gap-3.5 border-b border-border px-7 pt-6 pb-[18px]">
        <div className="flex items-baseline justify-between gap-4 pr-8">
          <DialogTitle className="text-lg">{t('writingStyle.calibration.title')}</DialogTitle>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {t('writingStyle.calibration.progress', {
              current: step.step + 1,
              total: step.total,
            })}
          </span>
        </div>
        <ProgressSegments current={step.step} total={step.total} />
        <DialogDescription className="text-[13px] leading-normal">
          {t('writingStyle.calibration.instructions')}
        </DialogDescription>
      </div>

      <div className="grid grid-cols-2 gap-4 px-7 pt-5 pb-4">
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[11px] uppercase text-muted-foreground">
            {t('writingStyle.calibration.voiceboxWrote')}
          </span>
          <p className="min-h-[180px] flex-1 whitespace-pre-wrap rounded-lg border border-border bg-card p-3.5 text-[15px] leading-relaxed text-foreground/75">
            {original}
          </p>
        </div>
        <label className="flex flex-col gap-2">
          <span className="font-mono text-[11px] uppercase text-accent">
            {t('writingStyle.calibration.paragraphLabel')}
          </span>
          <textarea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.metaKey) {
                event.preventDefault();
                save();
              }
            }}
            disabled={busy}
            // biome-ignore lint/a11y/noAutofocus: the dialog exists to edit this box
            autoFocus
            className="min-h-[180px] flex-1 resize-none rounded-lg border border-accent bg-background p-3.5 text-[15px] leading-relaxed text-foreground outline-none disabled:opacity-60"
          />
        </label>
      </div>

      {step.said && (
        <p className="px-7 pb-3 text-xs text-muted-foreground">
          <span className="font-mono text-[11px] uppercase">
            {t('writingStyle.calibration.said')}
          </span>
          {' · '}
          {step.said}
        </p>
      )}

      <div className="flex min-h-5 flex-wrap gap-x-5 gap-y-1 px-7 pb-5 font-mono text-xs text-muted-foreground">
        {submitting ? (
          <span>{t('writingStyle.calibration.cleaning')}</span>
        ) : (
          <>
            {wordDelta !== 0 && (
              <span>
                {t('writingStyle.calibration.wordDelta', {
                  count: Math.abs(wordDelta),
                  sign: wordDelta < 0 ? '−' : '+',
                })}
              </span>
            )}
            {step.habits.length > 0 && (
              <span className="text-foreground/70">{t('writingStyle.calibration.pickedUp')}</span>
            )}
            {step.habits.map((habit) => (
              <span key={habit}>{t(`writingStyle.habitChips.${habit}`)}</span>
            ))}
          </>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-7 py-4">
        <span className="flex-1" />
        {/* Sends Voicebox's paragraph back untouched: it already reads like the user. */}
        <Button variant="outline" disabled={busy || !original} onClick={() => onSubmit(original)}>
          {t('writingStyle.calibration.looksLikeMe')}
        </Button>
        <Button className="font-semibold" disabled={!canSave} onClick={save}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {isLast
            ? t('writingStyle.calibration.saveFinish')
            : t('writingStyle.calibration.saveNext')}
          <Kbd className="border-accent-foreground/25 text-accent-foreground/80">⌘⏎</Kbd>
        </Button>
      </div>
    </>
  );
}

function ProgressSegments({ current, total }: { current: number; total: number }) {
  return (
    <div
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}
      aria-hidden="true"
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length segments
          key={i}
          className={cn('h-[3px] rounded-sm', i <= current ? 'bg-accent' : 'bg-input')}
        />
      ))}
    </div>
  );
}
