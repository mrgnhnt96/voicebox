import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useState } from 'react';
import type { NativeDictationEvent } from '@/lib/hooks/useNativeDictationSession';

/**
 * The main window's Dictate button in the desktop app. Rust records natively
 * (the same path as the global shortcut) and the HUD shows the take; the text
 * lands in Captures instead of being pasted. `isRecording` follows every take,
 * including ones started from the shortcut, so the button always offers Stop
 * while something is recording.
 */
export function useInAppDictation(enabled: boolean): {
  isRecording: boolean;
  toggle: () => void;
} {
  const [isRecording, setIsRecording] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let release: (() => void) | undefined;
    // A take still finishing (refining, done) must not flip the button back
    // to Dictate while a newer take is recording.
    let currentTake = 0;
    listen<NativeDictationEvent>('dictation:state', ({ payload }) => {
      if (payload.state === 'preparing') {
        if (payload.take < currentTake) return;
        currentTake = payload.take;
      } else if (payload.take !== currentTake) {
        return;
      }
      setIsRecording(payload.state === 'preparing' || payload.state === 'recording');
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else release = unlisten;
      })
      .catch((err) => console.warn('[dictate] dictation listener failed:', err));
    return () => {
      disposed = true;
      release?.();
    };
  }, [enabled]);

  const toggle = useCallback(() => {
    const command = isRecording ? 'dictation_stop' : 'dictation_start';
    invoke(command).catch((err) => console.warn(`[dictate] ${command} failed:`, err));
  }, [isRecording]);

  return { isRecording, toggle };
}
