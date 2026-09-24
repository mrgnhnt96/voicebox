import { Link } from '@tanstack/react-router';
import { Loader2, Mic, Settings2, Square, Upload } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CapturePill } from '@/components/CapturePill/CapturePill';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import type { CaptureResponse } from '@/lib/api/types';
import type { useCaptureRecordingSession } from '@/lib/hooks/useCaptureRecordingSession';
import { useInAppDictation } from '@/lib/hooks/useInAppDictation';
import { useCaptureSettings } from '@/lib/hooks/useSettings';
import { displayLabelForKey, sortChordKeys } from '@/lib/utils/keyCodes';
import { usePlatform } from '@/platform/PlatformContext';
import { formatDuration, formatStamp } from './captureFormat';

const CAPTURE_AUDIO_MIME = 'audio/*,.wav,.mp3,.m4a,.flac,.ogg,.webm';

export type CaptureSession = ReturnType<typeof useCaptureRecordingSession>;

/** The saved dictation chord as one label ("⌥ Space"), or null when it's off. */
function useDictationShortcutLabel(): string | null {
  const { settings } = useCaptureSettings();
  if (!settings?.hotkey_enabled) return null;
  const keys = settings.chord_push_to_talk_keys?.length
    ? settings.chord_push_to_talk_keys
    : (settings.chord_toggle_to_talk_keys ?? []);
  if (!keys.length) return null;
  return sortChordKeys(keys).map(displayLabelForKey).join(' ');
}

/**
 * The detail pane's header: the selected capture's meta on the left, and the
 * in-app recording controls on the right (Import audio, Dictate/Stop).
 *
 * In the desktop app Dictate records natively, like the global shortcut, and
 * the floating HUD shows the take. The web build records through `session`
 * and shows its pill here. Import always goes through `session`.
 */
export function CaptureDetailHeader({
  capture,
  session,
  canRecord,
}: {
  capture: CaptureResponse | null;
  session: CaptureSession;
  canRecord: boolean;
}) {
  const { t } = useTranslation();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const shortcut = useDictationShortcutLabel();
  const isTauri = usePlatform().metadata.isTauri;
  const native = useInAppDictation(isTauri);
  const isRecording = isTauri ? native.isRecording : session.isRecording;
  const toggleRecording = isTauri ? native.toggle : session.toggleRecording;

  const meta = capture
    ? [
        formatStamp(capture.created_at),
        capture.source,
        capture.language?.toLowerCase(),
        formatDuration(capture.duration_ms),
      ].filter(Boolean)
    : [];

  const handleUploadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) session.uploadFile(file, 'file');
  };

  return (
    <header className="h-16 shrink-0 flex items-center gap-2 px-6 border-b border-border">
      <input
        ref={uploadInputRef}
        type="file"
        accept={CAPTURE_AUDIO_MIME}
        onChange={handleUploadFile}
        className="hidden"
        tabIndex={-1}
        aria-hidden
      />
      <p className="flex-1 min-w-0 truncate font-mono text-xs text-muted-foreground">
        {meta.join(' · ')}
      </p>

      {!isTauri && session.pillState !== 'hidden' ? (
        <CapturePill
          state={session.pillState}
          errorMessage={session.errorMessage}
          onDismiss={session.dismissError}
          onStop={session.isRecording ? session.stopRecording : undefined}
        />
      ) : (
        <>
          <Button variant="ghost" size="icon" asChild>
            <Link to="/settings/dictation" aria-label={t('captures.actions.configure')}>
              <Settings2 />
            </Link>
          </Button>
          {canRecord && (
            <Button
              variant="outline"
              onClick={() => uploadInputRef.current?.click()}
              disabled={session.isUploading}
            >
              {session.isUploading ? <Loader2 className="animate-spin" /> : <Upload />}
              {session.isUploading ? t('captures.actions.importing') : t('captures.actions.import')}
            </Button>
          )}
        </>
      )}

      {/* Hide Dictate when recording readiness fails so the user can't kick off
          a capture that has nowhere to land. Stop stays visible if a recording
          is somehow already in flight (e.g. a model was uninstalled mid-record)
          so the user can always cancel. */}
      {(canRecord || isRecording) && (
        <Button
          size="lg"
          className="h-10 pl-3 pr-3.5 gap-2.5 font-semibold"
          onClick={toggleRecording}
          disabled={session.isUploading && !isRecording}
        >
          {isRecording ? <Square className="fill-current" /> : <Mic />}
          {isRecording ? t('captures.actions.stop') : t('captures.actions.dictate')}
          {shortcut && !isRecording && (
            <Kbd className="border-0 bg-black/15 text-accent-foreground font-medium">
              {shortcut}
            </Kbd>
          )}
        </Button>
      )}
    </header>
  );
}
