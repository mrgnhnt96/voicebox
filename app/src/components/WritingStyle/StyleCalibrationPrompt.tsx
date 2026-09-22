import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useWritingStyle } from '@/lib/hooks/useWritingStyle';
import { StyleCalibrationDialog } from './StyleCalibrationDialog';

const DISMISSED_KEY = 'voicebox.writingStyle.promptDismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * First-run invitation to calibrate, shown once the user has dictated and
 * until they calibrate or dismiss it. Never blocks dictating.
 */
export function StyleCalibrationPrompt({ hasCaptures }: { hasCaptures: boolean }) {
  const { t } = useTranslation();
  const { data: status } = useWritingStyle();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [open, setOpen] = useState(false);

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Private windows can refuse storage; it just shows again next time.
    }
  };

  const show = hasCaptures && status !== undefined && status.runs === 0 && !dismissed;
  return (
    <>
      {show && (
        <div className="mx-1 mb-3 rounded-lg border border-accent/30 bg-accent/5 p-3 space-y-2">
          <p className="text-sm font-medium">{t('writingStyle.prompt.title')}</p>
          <p className="text-xs text-muted-foreground">{t('writingStyle.prompt.description')}</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setOpen(true)}>
              {t('writingStyle.prompt.start')}
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss}>
              {t('writingStyle.prompt.dismiss')}
            </Button>
          </div>
        </div>
      )}
      <StyleCalibrationDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
