import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect, useRef } from 'react';
import { CapturePill } from '@/components/CapturePill/CapturePill';
import type { FocusSnapshot } from '@/lib/api/types';
import { useCaptureRecordingSession } from '@/lib/hooks/useCaptureRecordingSession';
import {
  type NativeDictationSession,
  useNativeDictationSession,
} from '@/lib/hooks/useNativeDictationSession';
import { usePlatform } from '@/platform/PlatformContext';

/**
 * Floating dictate surface shown in a separate transparent Tauri window.
 * Mounted when the URL contains ``?view=dictate``. The main window bypasses
 * this branch and renders the full app shell.
 *
 * The pill surfaces for user dictation. In the desktop app Rust owns the
 * whole take — microphone, streaming, paste (``tauri/src-tauri/src/dictation``)
 * — and reports ``dictation:state``; this webview never opens browser audio
 * for it. The web build keeps the browser recording path.
 */
export function DictateWindow() {
  const platform = usePlatform();
  return platform.metadata.isTauri ? <NativeDictateWindow /> : <BrowserDictateWindow />;
}

function NativeDictateWindow() {
  const session = useNativeDictationSession();
  return <DictateSurface session={session} />;
}

/** Web build: dictation through browser audio, driven by chord events. */
function BrowserDictateWindow() {
  const session = useCaptureRecordingSession({
    onFinalText: async (text, _capture, allowAutoPaste, context) => {
      // Focus is the snapshot taken at chord-start and threaded through as this
      // take's context, so it survives the 1–2 s transcribe + refine window and
      // overlapping dictations can't paste into each other's target.
      const focus = context as FocusSnapshot | null;
      if (!allowAutoPaste) return;
      if (!text.trim()) return;
      if (!focus)
        throw new Error('Could not identify the paste target. Check Accessibility permission.');
      try {
        const pasted = await invoke<boolean>('paste_final_text', { text, focus });
        if (!pasted) throw new Error('Paste target unavailable. Copy the text from Captures.');
      } catch (err) {
        // Surface accessibility failures to the main window so it can prompt
        // the user to grant permission. The session displays delivery errors;
        // the transcription remains available in the captures list.
        const msg = err instanceof Error ? err.message : String(err);
        if (/accessibility/i.test(msg)) {
          emit('system:accessibility-missing').catch(() => {});
        }
        console.warn('[dictate] paste_final_text failed:', err);
        throw new Error(msg);
      }
    },
  });

  // Route chord events into the session hook. Using a ref so the `listen`
  // effect only subscribes once — rebinding every render would thrash the
  // event bridge.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    let disposed = false;
    const unlistens: UnlistenFn[] = [];
    const registrations = [
      listen<{ focus: FocusSnapshot | null }>('dictate:start', (event) => {
        sessionRef.current.startRecording(event.payload?.focus ?? null);
      }),
      listen('dictate:stop', () => {
        // Forward stops that arrive while getUserMedia is still resolving.
        sessionRef.current.stopRecording();
      }),
    ];
    Promise.all(registrations)
      .then((registered) => {
        if (disposed) {
          for (const unlisten of registered) unlisten();
          return;
        }
        unlistens.push(...registered);
      })
      .catch((err) => console.warn('[dictate] event listener registration failed:', err));
    return () => {
      disposed = true;
      for (const unlisten of unlistens) unlisten();
    };
  }, []);

  return <DictateSurface session={session} />;
}

/** The pill, shared by both dictation paths. */
function DictateSurface({ session }: { session: NativeDictationSession }) {
  // Force the host document chrome to be transparent so the Tauri window
  // takes on the pill's own shape.
  useEffect(() => {
    const prevHtml = document.documentElement.style.background;
    const prevBody = document.body.style.background;
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return () => {
      document.documentElement.style.background = prevHtml;
      document.body.style.background = prevBody;
    };
  }, []);

  const effectiveState = session.pillState;

  // When the pill cycle ends, tell Rust to tuck
  // the window away. Rust owns the hide + park-off-screen + click-through
  // combo because calling hide() directly from JS has been unreliable for
  // transparent always-on-top windows on macOS.
  useEffect(() => {
    if (effectiveState === 'hidden') {
      emit('dictate:hide').catch(() => {});
    }
  }, [effectiveState]);

  return (
    <div
      className="h-screen w-screen flex items-center justify-center px-3"
      style={{ background: 'transparent' }}
    >
      {effectiveState !== 'hidden' ? (
        <CapturePill
          state={effectiveState}
          elapsedMs={session.pillElapsedMs}
          errorMessage={session.errorMessage}
          onDismiss={session.dismissError}
          onStop={session.isRecording ? session.stopRecording : undefined}
        />
      ) : null}
    </div>
  );
}
