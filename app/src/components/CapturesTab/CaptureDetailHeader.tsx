import { Link } from '@tanstack/react-router';
import { Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import type { CaptureResponse } from '@/lib/api/types';
import { AppIcon } from './AppIcon';
import { CaptureInlinePlayer } from './CaptureInlinePlayer';
import { formatDetailStamp } from './captureFormat';

/**
 * The detail pane's header: the app the capture went to and when, its audio,
 * and a link to the dictation settings. Everything else about the capture is
 * in the inspector beside it.
 */
export function CaptureDetailHeader({ capture }: { capture: CaptureResponse | null }) {
  const { t } = useTranslation();

  return (
    <header className="h-16 shrink-0 flex items-center gap-3 pl-6 pr-3 border-b border-border">
      {capture ? (
        <>
          <AppIcon bundleId={capture.app_bundle_id} className="size-6" />
          <div className="flex-1 min-w-0 flex flex-col">
            <p className="truncate text-sm font-semibold">
              {capture.app_name || t(`captures.source.${capture.source}`)}
            </p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {formatDetailStamp(capture.created_at, {
                today: t('captures.detail.today'),
                yesterday: t('captures.detail.yesterday'),
              })}
            </p>
          </div>
          <CaptureInlinePlayer
            audioUrl={apiClient.getCaptureAudioUrl(capture.id)}
            fallbackDurationMs={capture.duration_ms}
            className="w-60 shrink-0"
          />
        </>
      ) : (
        <span className="flex-1" />
      )}
      <Button variant="ghost" size="icon" asChild>
        <Link to="/settings/dictation" aria-label={t('captures.actions.configure')}>
          <Settings2 />
        </Link>
      </Button>
    </header>
  );
}
