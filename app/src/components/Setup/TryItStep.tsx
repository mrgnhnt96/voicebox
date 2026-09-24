import { Link } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useCaptureSettings } from '@/lib/hooks/useSettings';
import { cn } from '@/lib/utils/cn';
import { defaultChordKeys } from '@/lib/utils/keyCodes';
import { ChordKeycaps } from './ChordKeycaps';

interface TryItStepProps {
  doneCount: number;
  total: number;
  onBack: () => void;
}

/** The last screen: a practice box to dictate into, then off to Captures. */
export function TryItStep({ doneCount, total, onBack }: TryItStepProps) {
  const { t } = useTranslation();
  const { settings } = useCaptureSettings();
  const savedPush = settings?.chord_push_to_talk_keys;
  const keys = useMemo(() => savedPush ?? defaultChordKeys('push'), [savedPush]);
  const allDone = doneCount === total;

  return (
    <div className="flex flex-col gap-[22px]">
      <div
        className={cn(
          'flex items-center gap-2.5 font-mono text-xs',
          allDone ? 'text-success' : 'text-muted-foreground',
        )}
      >
        {allDone ? <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden /> : null}
        {allDone
          ? t('setup.allSet', { done: doneCount, total })
          : t('setup.progress', { done: doneCount, total })}
      </div>
      <h1 className="text-[30px] font-semibold">{t('setup.tryIt.title')}</h1>
      <p className="flex flex-wrap items-center gap-2.5 text-base text-foreground/85">
        {t('setup.tryIt.instructionBefore')}
        <ChordKeycaps keys={keys} />
        {t('setup.tryIt.instructionAfter')}
      </p>
      {allDone ? null : <p className="text-[13px] text-warning">{t('setup.tryIt.notReady')}</p>}
      <label className="flex flex-col gap-2 text-xs text-muted-foreground">
        {t('setup.tryIt.practiceLabel')}
        <textarea
          rows={4}
          className="resize-none rounded-[10px] border border-input bg-card px-4 py-3.5 text-base leading-relaxed text-foreground outline-none focus:border-accent"
        />
      </label>
      <div className="flex items-center justify-between gap-4 pt-2.5">
        <Button variant="outline" size="lg" onClick={onBack}>
          {t('setup.back')}
        </Button>
        <span className="flex-1 text-[13px] text-muted-foreground">{t('setup.tryIt.anyApp')}</span>
        <Button asChild size="lg">
          <Link to="/captures">{t('setup.tryIt.goToCaptures')}</Link>
        </Button>
      </div>
    </div>
  );
}
