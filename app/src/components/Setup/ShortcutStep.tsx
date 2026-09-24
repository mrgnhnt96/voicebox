import { Keyboard } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChordPicker } from '@/components/ChordPicker/ChordPicker';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { useCaptureSettings } from '@/lib/hooks/useSettings';
import { defaultChordKeys } from '@/lib/utils/keyCodes';
import { ChordKeycaps } from './ChordKeycaps';

/**
 * Step 4 body: pick the push-to-talk chord and arm the global shortcut.
 * Saving a chord here also turns the shortcut on, since picking one is the
 * whole point of the step. The hands-free chord keeps its current value.
 */
export function ShortcutStep() {
  const { t } = useTranslation();
  const { settings, update } = useCaptureSettings();
  const [pickerOpen, setPickerOpen] = useState(false);

  const hotkeyEnabled = settings?.hotkey_enabled ?? false;
  // Stable references: ChordPicker resets its captured keys whenever
  // ``initialKeys`` changes identity, so a fresh default array per render
  // would wipe the chord mid-capture.
  const savedPush = settings?.chord_push_to_talk_keys;
  const savedToggle = settings?.chord_toggle_to_talk_keys;
  const pushToTalkKeys = useMemo(() => savedPush ?? defaultChordKeys('push'), [savedPush]);
  const toggleToTalkKeys = useMemo(() => savedToggle ?? defaultChordKeys('toggle'), [savedToggle]);

  return (
    <>
      <p className="text-sm leading-relaxed text-foreground/85">{t('setup.shortcut.body')}</p>

      <div className="flex flex-col gap-2.5 text-[13px] text-muted-foreground">
        <div className="flex items-center justify-between gap-3">
          <span>{t('setup.shortcut.pushToTalk')}</span>
          <div className="flex items-center gap-3">
            <ChordKeycaps keys={pushToTalkKeys} />
            <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
              <Keyboard className="h-3.5 w-3.5" aria-hidden />
              {t('setup.shortcut.change')}
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span>
            {t('setup.shortcut.handsFree')}{' '}
            <span className="text-xs">· {t('setup.shortcut.handsFreeHint')}</span>
          </span>
          <ChordKeycaps keys={toggleToTalkKeys} />
        </div>
      </div>

      <label
        htmlFor="setup-hotkey-enabled"
        className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5"
      >
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px]">{t('setup.shortcut.enable')}</span>
          <span className="text-xs text-muted-foreground">{t('setup.shortcut.enableHint')}</span>
        </span>
        <Toggle
          id="setup-hotkey-enabled"
          checked={hotkeyEnabled}
          onCheckedChange={(v) => update({ hotkey_enabled: v })}
        />
      </label>

      <ChordPicker
        open={pickerOpen}
        title={t('setup.shortcut.pickerTitle')}
        description={t('setup.shortcut.pickerDescription')}
        initialKeys={pushToTalkKeys}
        onCancel={() => setPickerOpen(false)}
        onSave={(keys) => {
          update({ chord_push_to_talk_keys: keys, hotkey_enabled: true });
          setPickerOpen(false);
        }}
      />
    </>
  );
}
