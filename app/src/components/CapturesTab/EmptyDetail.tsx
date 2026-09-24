import { Link } from '@tanstack/react-router';
import { Captions } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { useCaptureSettings } from '@/lib/hooks/useSettings';
import { displayLabelForKey, modifierSideHint, sortChordKeys } from '@/lib/utils/keyCodes';

function ChordKeys({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {sortChordKeys(keys).map((key) => {
        const side = modifierSideHint(key);
        return (
          <Kbd key={key} className="h-6 min-w-6 text-foreground">
            {displayLabelForKey(key)}
            {side && <span className="ml-0.5 text-[9px] text-accent">{side}</span>}
          </Kbd>
        );
      })}
    </span>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center p-6 text-muted-foreground">
      <div className="max-w-sm text-center space-y-4">{children}</div>
    </div>
  );
}

/** The detail pane when no capture is selected: loading, pick one, or how to make the first. */
export function EmptyDetail({
  loading,
  hasCaptures,
  canRecord,
}: {
  loading: boolean;
  hasCaptures: boolean;
  canRecord: boolean;
}) {
  const { t } = useTranslation();
  const { settings } = useCaptureSettings();
  const hotkeyEnabled = settings?.hotkey_enabled ?? false;
  const pushKeys = settings?.chord_push_to_talk_keys ?? [];
  const toggleKeys = settings?.chord_toggle_to_talk_keys ?? [];

  if (loading || hasCaptures) {
    return (
      <Centered>
        <Captions className="h-8 w-8 mx-auto opacity-40" />
        <p className="text-[13px]">
          {loading ? t('captures.empty.loading') : t('captures.empty.pickOne')}
        </p>
      </Centered>
    );
  }

  if (hotkeyEnabled && !canRecord) {
    return (
      <Centered>
        <p className="text-[13px] text-foreground">{t('captures.notReady.title')}</p>
        <p className="text-xs leading-relaxed">{t('captures.notReady.description')}</p>
        <Button asChild size="sm">
          <Link to="/setup">{t('captures.notReady.action')}</Link>
        </Button>
      </Centered>
    );
  }

  if (hotkeyEnabled && (pushKeys.length || toggleKeys.length)) {
    return (
      <Centered>
        <div className="space-y-2.5">
          {pushKeys.length > 0 && (
            <div className="flex items-center justify-center gap-3">
              <ChordKeys keys={pushKeys} />
              <span className="font-mono text-[11px] uppercase">
                {t('captures.empty.holdToRecord')}
              </span>
            </div>
          )}
          {toggleKeys.length > 0 && (
            <div className="flex items-center justify-center gap-3">
              <ChordKeys keys={toggleKeys} />
              <span className="font-mono text-[11px] uppercase">
                {t('captures.empty.toggleHandsFree')}
              </span>
            </div>
          )}
        </div>
        <p className="text-[13px]">{t('captures.empty.pressShortcut')}</p>
      </Centered>
    );
  }

  return (
    <Centered>
      <Captions className="h-8 w-8 mx-auto opacity-40" />
      <p className="text-[13px] text-foreground">{t('captures.empty.none')}</p>
      <p className="text-xs leading-relaxed">{t('captures.empty.turnOnShortcut')}</p>
      <Button asChild variant="outline" size="sm">
        <Link to="/settings/dictation">{t('captures.empty.openSettings')}</Link>
      </Button>
    </Centered>
  );
}
