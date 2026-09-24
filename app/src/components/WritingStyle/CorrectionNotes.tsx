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

export const CORRECTION_NOTES_KEY = ['correction-notes'] as const;

/** Rules summarized from examples too old to show the cleanup model. */
export function CorrectionNotes() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const status = useQuery({
    queryKey: CORRECTION_NOTES_KEY,
    queryFn: () => apiClient.getCorrectionNotes(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiClient.removeCorrectionNote(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CORRECTION_NOTES_KEY }),
    onError: (error: Error) =>
      toast({
        title: t('writingStyle.settings.notes.removeFailed'),
        description: error.message,
        variant: 'destructive',
      }),
  });
  const notes = status.data?.notes ?? [];

  return (
    <SettingRow
      title={t('writingStyle.settings.notes.title')}
      description={
        notes.length
          ? t('writingStyle.settings.notes.description', { count: notes.length })
          : t('writingStyle.settings.notes.empty')
      }
      action={
        <Button size="sm" variant="outline" disabled={!notes.length} onClick={() => setOpen(true)}>
          {t('writingStyle.settings.notes.view')}
        </Button>
      }
    >
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('writingStyle.settings.notes.dialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('writingStyle.settings.notes.dialogDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {notes.map((note) => (
              <div key={note.id} className="flex items-center gap-2 rounded-md border p-3 text-sm">
                <p className="flex-1">{note.text}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(note.id)}
                >
                  {t('writingStyle.settings.notes.remove')}
                </Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </SettingRow>
  );
}
