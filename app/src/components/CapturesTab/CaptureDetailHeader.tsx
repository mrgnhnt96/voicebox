import { Link } from '@tanstack/react-router';
import { Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { CaptureResponse } from '@/lib/api/types';
import { formatDuration, formatStamp } from './captureFormat';

/**
 * The detail pane's header: the selected capture's meta on the left, and a
 * link to the dictation settings. Dictation starts from the global shortcut.
 */
export function CaptureDetailHeader({ capture }: { capture: CaptureResponse | null }) {
  const { t } = useTranslation();
  const meta = capture
    ? [
        formatStamp(capture.created_at),
        capture.source,
        capture.language?.toLowerCase(),
        formatDuration(capture.duration_ms),
      ].filter(Boolean)
    : [];

  return (
    <header className="h-16 shrink-0 flex items-center gap-2 px-6 border-b border-border">
      <p className="flex-1 min-w-0 truncate font-mono text-xs text-muted-foreground">
        {meta.join(' · ')}
      </p>
      <Button variant="ghost" size="icon" asChild>
        <Link to="/settings/dictation" aria-label={t('captures.actions.configure')}>
          <Settings2 />
        </Link>
      </Button>
    </header>
  );
}
