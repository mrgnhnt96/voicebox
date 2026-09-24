import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingRow, SettingSection } from '@/components/ServerTab/SettingRow';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { useCaptureSettings } from '@/lib/hooks/useSettings';
import { useWritingStyle, WRITING_STYLE_KEY } from '@/lib/hooks/useWritingStyle';
import { CorrectionNotes } from './CorrectionNotes';
import { PERSONAL_EXAMPLES_KEY, PersonalExamples } from './PersonalExamples';
import { StyleCalibrationDialog } from './StyleCalibrationDialog';
import { WritingStyleHabits } from './WritingStyleHabits';

/** The calibration tile in Settings > Captures. */
export function WritingStyleSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: status } = useWritingStyle();
  const { settings, update } = useCaptureSettings();
  const [open, setOpen] = useState(false);
  const reset = useMutation({
    mutationFn: () => apiClient.resetWritingStyle(),
    onSuccess: (data) => {
      queryClient.setQueryData(WRITING_STYLE_KEY, data);
      queryClient.invalidateQueries({ queryKey: PERSONAL_EXAMPLES_KEY });
      // Nothing is left to match, so fall back to the default style.
      if (settings?.punctuation_style === 'learned') update({ punctuation_style: 'standard' });
    },
  });
  const runs = status?.runs ?? 0;

  return (
    <SettingSection
      title={t('writingStyle.settings.title')}
      description={t('writingStyle.settings.description')}
    >
      <SettingRow
        title={t('writingStyle.settings.calibrate.title')}
        description={
          status?.last_run_at
            ? t('writingStyle.settings.calibrate.lastRun', {
                date: new Date(status.last_run_at).toLocaleDateString(),
                count: runs,
              })
            : t('writingStyle.settings.calibrate.description')
        }
        action={
          <Button size="sm" onClick={() => setOpen(true)}>
            {runs
              ? t('writingStyle.settings.calibrate.again')
              : t('writingStyle.settings.calibrate.start')}
          </Button>
        }
      >
        {status?.habits.length ? (
          <div className="text-sm text-muted-foreground">
            <WritingStyleHabits habits={status.habits} />
          </div>
        ) : null}
      </SettingRow>
      <PersonalExamples />
      <CorrectionNotes />
      {status?.ready || runs ? (
        <SettingRow
          title={t('writingStyle.settings.reset.title')}
          description={t('writingStyle.settings.reset.description')}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => reset.mutate()}
              disabled={reset.isPending}
            >
              {t('writingStyle.settings.reset.action')}
            </Button>
          }
        />
      ) : null}
      <StyleCalibrationDialog open={open} onOpenChange={setOpen} />
    </SettingSection>
  );
}
