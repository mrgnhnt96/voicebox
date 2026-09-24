import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChordKeys } from '@/components/Settings/ChordKeys';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { canonicalKeyFromEvent, sortChordKeys } from '@/lib/utils/keyCodes';

interface ChordPickerProps {
  open: boolean;
  /** Title shown in the modal — caller picks "push-to-talk" vs "toggle". */
  title: string;
  description?: string;
  /** The chord currently saved, shown as the starting state. */
  initialKeys: string[];
  onSave: (keys: string[]) => void;
  onCancel: () => void;
  /** Extra notes under the capture area, such as a related shortcut. */
  children?: ReactNode;
}

/**
 * Modal that captures a key chord from the browser keyboard. Tracks the
 * peak set of keys held during the session so the user can release
 * before clicking Save (otherwise they'd be saving while still holding
 * the shortcut, which is awkward).
 *
 * Browser limitation: we can only capture keys while Voicebox has key
 * focus, so the picker pulls focus to a hidden capture surface inside
 * the dialog. The actual chord runs through the Rust global hook —
 * this picker only writes the configuration the hook reads.
 */
export function ChordPicker({
  open,
  title,
  description,
  initialKeys,
  onSave,
  onCancel,
  children,
}: ChordPickerProps) {
  const { t } = useTranslation();
  // Currently held set, peak set captured this session, and "is the user
  // mid-chord?". We freeze the peak when they release everything so the
  // Save button can read a stable value.
  const [pressed, setPressed] = useState<Set<string>>(new Set());
  const [captured, setCaptured] = useState<string[]>(initialKeys);
  const [unsupportedAttempt, setUnsupportedAttempt] = useState<string | null>(null);
  const captureRef = useRef<HTMLDivElement>(null);

  // Reset every time the modal re-opens — otherwise the previous picker
  // session's peak set leaks into the next open and confuses the user.
  useEffect(() => {
    if (open) {
      setPressed(new Set());
      setCaptured(initialKeys);
      setUnsupportedAttempt(null);
      // Defer focus to the next paint so the dialog is mounted.
      const timeoutId = window.setTimeout(() => captureRef.current?.focus(), 50);
      return () => window.clearTimeout(timeoutId);
    }
    return;
  }, [open, initialKeys]);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    // Esc reaches the dialog's onOpenChange and closes the modal — let
    // it pass through unmodified.
    if (event.key === 'Escape') return;
    // Tab cycles focus inside the dialog; capturing it would trap the
    // user. Same for the dialog's own keyboard interactions.
    if (event.key === 'Tab') return;

    const canonical = canonicalKeyFromEvent(event);
    if (!canonical) {
      setUnsupportedAttempt(event.code || event.key || 'unknown');
      event.preventDefault();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setUnsupportedAttempt(null);

    setPressed((prev) => {
      if (prev.has(canonical)) return prev;
      const next = new Set(prev);
      next.add(canonical);
      setCaptured((prevCaptured) => {
        const candidate = sortChordKeys(Array.from(next));
        // First key in a fresh sequence replaces the peak — otherwise a
        // user trying to swap a longer saved chord for a shorter one is
        // stuck because their candidate never beats the seed length.
        if (prev.size === 0) return candidate;
        return candidate.length >= prevCaptured.length ? candidate : prevCaptured;
      });
      return next;
    });
  }, []);

  const handleKeyUp = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape' || event.key === 'Tab') return;
    const canonical = canonicalKeyFromEvent(event);
    if (!canonical) return;
    event.preventDefault();
    setPressed((prev) => {
      if (!prev.has(canonical)) return prev;
      const next = new Set(prev);
      next.delete(canonical);
      return next;
    });
  }, []);

  // Wire global listeners only while open. Capture phase so Voicebox's
  // own command palette / global shortcuts don't swallow the chord first.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
    };
  }, [open, handleKeyDown, handleKeyUp]);

  const displayKeys = pressed.size > 0 ? sortChordKeys(Array.from(pressed)) : captured;

  const canSave = captured.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="gap-[18px] sm:max-w-[480px]">
        <DialogHeader className="space-y-1.5">
          <DialogTitle className="text-lg">{title}</DialogTitle>
          {description ? (
            <DialogDescription className="text-[13px] leading-normal">
              {description}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        <div
          ref={captureRef}
          tabIndex={-1}
          aria-live="polite"
          className="flex min-h-[110px] flex-col items-center justify-center gap-3 rounded-[10px] border border-dashed border-accent bg-accent/5 px-4 py-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {displayKeys.length === 0 ? (
            <span className="font-mono text-sm text-muted-foreground">
              {t('captures.chord.noKeys')}
            </span>
          ) : (
            <ChordKeys keys={displayKeys} size="lg" />
          )}
          <span className="font-mono text-[11px] text-accent">
            {pressed.size > 0
              ? t('captures.chord.capturing')
              : captured.length > 0 && captured !== initialKeys
                ? t('captures.chord.captured')
                : t('captures.chord.pressShortcut')}
          </span>
          {unsupportedAttempt ? (
            <p className="text-xs text-destructive">
              {t('captures.chord.unsupported', { key: unsupportedAttempt })}
            </p>
          ) : null}
        </div>

        {children}

        <DialogFooter className="gap-2 sm:space-x-0">
          <Button variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button className="font-semibold" onClick={() => onSave(captured)} disabled={!canSave}>
            {t('captures.chord.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
