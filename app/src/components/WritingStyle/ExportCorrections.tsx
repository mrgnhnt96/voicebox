import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SettingRow } from '@/components/ServerTab/SettingRow';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import { usePlatform } from '@/platform/PlatformContext';

/** Saves every correction the user made as one JSON file. */
export function ExportCorrections() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const platform = usePlatform();
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

  return (
    <SettingRow
      title={t('writingStyle.settings.export.title')}
      description={t('writingStyle.settings.export.description')}
      action={
        <Button
          size="sm"
          variant="outline"
          disabled={exportMutation.isPending}
          onClick={() => exportMutation.mutate()}
        >
          {t('writingStyle.settings.export.action')}
        </Button>
      }
    />
  );
}
