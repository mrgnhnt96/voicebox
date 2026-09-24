import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SettingRow } from '@/components/ServerTab/SettingRow';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { useCaptureSettings } from '@/lib/hooks/useSettings';
import { useWritingStyle, WRITING_STYLE_KEY } from '@/lib/hooks/useWritingStyle';
import { PERSONAL_EXAMPLES_KEY } from './PersonalExamples';

/** Forgets calibration and learned habits, after a confirmation. */
export function ResetWritingStyle() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: status } = useWritingStyle();
  const { settings, update } = useCaptureSettings();
  const reset = useMutation({
    mutationFn: () => apiClient.resetWritingStyle(),
    onSuccess: (data) => {
      queryClient.setQueryData(WRITING_STYLE_KEY, data);
      queryClient.invalidateQueries({ queryKey: PERSONAL_EXAMPLES_KEY });
      // Nothing is left to match, so fall back to the default style.
      if (settings?.punctuation_style === 'learned') update({ punctuation_style: 'standard' });
    },
  });

  // Nothing to forget until something has been learned.
  if (!status?.ready && !status?.runs) return null;

  return (
    <SettingRow
      title={t('writingStyle.settings.reset.title')}
      description={t('writingStyle.settings.reset.description')}
      action={
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={reset.isPending}
            >
              {t('writingStyle.settings.reset.action')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('writingStyle.settings.reset.confirmTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('writingStyle.settings.reset.description')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => reset.mutate()}
              >
                {t('writingStyle.settings.reset.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      }
    />
  );
}
