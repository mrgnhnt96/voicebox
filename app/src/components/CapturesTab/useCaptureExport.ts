import { save } from '@tauri-apps/plugin-dialog';
import { writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { CaptureResponse } from '@/lib/api/types';
import { buildCaptureMarkdown } from './captureFormat';

/** Save-to-disk exports of one capture: its audio, its transcript, or both as Markdown. */
export function useCaptureExport(capture: CaptureResponse) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const baseName = `capture_${capture.id.slice(0, 8)}`;

  const succeeded = (path: string) => {
    const name = path.split(/[\\/]/).pop() ?? path;
    toast({ title: t('captures.toast.exportSuccess', { path: name }) });
  };

  const failed = (err: unknown) => {
    toast({
      title: t('captures.toast.exportFailed'),
      description: err instanceof Error ? err.message : String(err),
      variant: 'destructive',
    });
  };

  const nothingToExport = () => {
    if ((capture.transcript_refined || capture.transcript_raw || '').trim()) return false;
    toast({ title: t('captures.toast.exportEmpty'), variant: 'destructive' });
    return true;
  };

  const exportAudio = async () => {
    try {
      const dest = await save({
        defaultPath: `${baseName}.wav`,
        filters: [{ name: 'Audio', extensions: ['wav'] }],
      });
      if (!dest) return;
      const res = await fetch(apiClient.getCaptureAudioUrl(capture.id));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeFile(dest, new Uint8Array(await res.arrayBuffer()));
      succeeded(dest);
    } catch (err) {
      failed(err);
    }
  };

  const exportTranscript = async () => {
    if (nothingToExport()) return;
    try {
      const dest = await save({
        defaultPath: `${baseName}.txt`,
        filters: [{ name: 'Text', extensions: ['txt'] }],
      });
      if (!dest) return;
      await writeTextFile(dest, (capture.transcript_refined || capture.transcript_raw).trim());
      succeeded(dest);
    } catch (err) {
      failed(err);
    }
  };

  const exportMarkdown = async () => {
    if (nothingToExport()) return;
    try {
      const dest = await save({
        defaultPath: `${baseName}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (!dest) return;
      await writeTextFile(dest, buildCaptureMarkdown(capture));
      succeeded(dest);
    } catch (err) {
      failed(err);
    }
  };

  return { exportAudio, exportTranscript, exportMarkdown };
}
