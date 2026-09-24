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

/** Every "what you said, what you meant" example, from calibration and corrections. */
export function usePersonalExamples() {
  return useQuery({
    queryKey: PERSONAL_EXAMPLES_KEY,
    queryFn: () => apiClient.listPersonalExamples(),
  });
}

/** Removes one example so cleanup stops learning from it. */
export function useRemovePersonalExample() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.removePersonalExample(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PERSONAL_EXAMPLES_KEY }),
    onError: (error: Error) =>
      toast({
        title: t('writingStyle.settings.examples.removeFailed'),
        description: error.message,
        variant: 'destructive',
      }),
  });
}

/** The "what you said, what you meant" examples cleanup learns from. */
export function PersonalExamples() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const examples = usePersonalExamples();
  const remove = useRemovePersonalExample();
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
          <ul className="space-y-2">
            {examples.data?.map((example) => (
              <li
                key={example.id}
                className="space-y-2.5 rounded-lg border border-border bg-card p-3.5 text-[13px]"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] uppercase text-muted-foreground">
                    {example.source === 'correction'
                      ? t('writingStyle.settings.examples.fromCorrection')
                      : t('writingStyle.settings.examples.fromCalibration')}
                  </span>
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-muted-foreground"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(example.id)}
                  >
                    {t('writingStyle.settings.examples.remove')}
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {t('writingStyle.settings.examples.said')}
                    </p>
                    <p className="whitespace-pre-wrap text-muted-foreground">{example.said}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="font-mono text-[11px] text-accent">
                      {t('writingStyle.settings.examples.meant')}
                    </p>
                    <p className="whitespace-pre-wrap">{example.meant}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </SettingRow>
  );
}
