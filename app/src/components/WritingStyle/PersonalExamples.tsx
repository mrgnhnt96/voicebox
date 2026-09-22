import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingRow } from '@/components/ServerTab/SettingRow';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';

export const PERSONAL_EXAMPLES_KEY = ['personal-examples'] as const;

/** The "what you said, what you meant" examples cleanup learns from. */
export function PersonalExamples() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const examples = useQuery({
    queryKey: PERSONAL_EXAMPLES_KEY,
    queryFn: () => apiClient.listPersonalExamples(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiClient.removePersonalExample(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PERSONAL_EXAMPLES_KEY }),
    onError: (error: Error) =>
      toast({
        title: t('writingStyle.settings.examples.removeFailed'),
        description: error.message,
        variant: 'destructive',
      }),
  });
  const count = examples.data?.length ?? 0;

  return (
    <SettingRow
      title={t('writingStyle.settings.examples.title')}
      description={
        count
          ? t('writingStyle.settings.examples.description', { count })
          : t('writingStyle.settings.examples.empty')
      }
      action={
        <Button size="sm" variant="outline" disabled={!count} onClick={() => setOpen(true)}>
          {t('writingStyle.settings.examples.view')}
        </Button>
      }
    >
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('writingStyle.settings.examples.dialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('writingStyle.settings.examples.dialogDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {examples.data?.map((example) => (
              <div key={example.id} className="rounded-md border p-3 space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {example.source === 'correction'
                      ? t('writingStyle.settings.examples.fromCorrection')
                      : t('writingStyle.settings.examples.fromCalibration')}
                  </span>
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(example.id)}
                  >
                    {t('writingStyle.settings.examples.remove')}
                  </Button>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('writingStyle.settings.examples.said')}
                  </p>
                  <p className="whitespace-pre-wrap text-muted-foreground">{example.said}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('writingStyle.settings.examples.meant')}
                  </p>
                  <p className="whitespace-pre-wrap">{example.meant}</p>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </SettingRow>
  );
}
