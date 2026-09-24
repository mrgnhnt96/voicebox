import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Captions, FileAudio, FileText, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { CaptureResponse } from '@/lib/api/types';
import { deliveredText, isInOverlay, isTypingTarget } from './captureFormat';
import { useCaptureExport } from './useCaptureExport';

/**
 * The bar under a capture: Copy ⌘C, Re-refine R, Export E and Delete ⌫.
 * The keys work whenever focus isn't in a text field or an open overlay.
 */
export function CaptureActionBar({
  capture,
  isRefining,
  onRefine,
}: {
  capture: CaptureResponse;
  isRefining: boolean;
  onRefine: (captureId: string) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [exportOpen, setExportOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { exportAudio, exportTranscript, exportMarkdown } = useCaptureExport(capture);

  const deleteMutation = useMutation({
    mutationFn: (captureId: string) => apiClient.deleteCapture(captureId),
    onSuccess: () => {
      setDeleteOpen(false);
      queryClient.invalidateQueries({ queryKey: ['captures'] });
    },
    onError: (err: Error) => {
      toast({
        title: t('captures.toast.deleteFailed'),
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(deliveredText(capture));
      toast({ title: t('captures.toast.transcriptCopied') });
    } catch {
      toast({ title: t('captures.toast.copyFailed'), variant: 'destructive' });
    }
  };

  // The listener is registered once, so it reads the latest handlers from a ref.
  const actions = useRef({ copy, refine: () => onRefine(capture.id), isRefining });
  actions.current = { copy, refine: () => onRefine(capture.id), isRefining };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey) return;
      if (isTypingTarget(event.target) || isInOverlay(event.target)) return;
      const key = event.key.toLowerCase();
      if (event.metaKey) {
        // Leave ⌘C alone when the user has selected text to copy.
        if (key === 'c' && !window.getSelection()?.toString()) {
          event.preventDefault();
          void actions.current.copy();
        }
        return;
      }
      if (event.shiftKey) return;
      if (key === 'r') {
        event.preventDefault();
        if (!actions.current.isRefining) actions.current.refine();
      } else if (key === 'e') {
        event.preventDefault();
        setExportOpen(true);
      } else if (key === 'backspace' || key === 'delete') {
        event.preventDefault();
        setDeleteOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="h-14 shrink-0 flex items-center gap-2 px-6 border-t border-border">
      <Button variant="secondary" className="border border-input" onClick={copy}>
        {t('captures.actions.copy')}
        <Kbd className="border-0 px-0">⌘C</Kbd>
      </Button>
      <Button variant="outline" onClick={() => onRefine(capture.id)} disabled={isRefining}>
        {isRefining && <Loader2 className="animate-spin" />}
        {capture.transcript_refined ? t('captures.actions.reRefine') : t('captures.actions.refine')}
        <Kbd className="border-0 px-0">R</Kbd>
      </Button>
      <DropdownMenu open={exportOpen} onOpenChange={setExportOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            {t('captures.actions.export')}
            <Kbd className="border-0 px-0">E</Kbd>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>{t('captures.actions.exportDropdownLabel')}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={exportAudio}>
            <FileAudio className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
            {t('captures.actions.exportAudio')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={exportTranscript}>
            <Captions className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
            {t('captures.actions.exportTranscript')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={exportMarkdown}>
            <FileText className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
            {t('captures.actions.exportMarkdown')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="flex-1" />
      <Button
        variant="ghost"
        className="text-destructive hover:text-destructive"
        onClick={() => setDeleteOpen(true)}
        disabled={deleteMutation.isPending}
      >
        {deleteMutation.isPending && <Loader2 className="animate-spin" />}
        {t('captures.actions.delete')}
        <Kbd className="border-0 px-0">⌫</Kbd>
      </Button>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('captures.deleteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('captures.deleteDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                variant="destructive"
                onClick={() => deleteMutation.mutate(capture.id)}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending
                  ? t('captures.deleteDialog.deleting')
                  : t('common.delete')}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
