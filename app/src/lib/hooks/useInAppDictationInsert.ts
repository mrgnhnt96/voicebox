import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import { usePlatform } from '@/platform/PlatformContext';

/** Input types that take free text. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', '']);

function isEditableField(element: Element | null): element is HTMLElement {
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  if (element instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(element.type) && !element.readOnly && !element.disabled;
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

/**
 * Type `text` into the focused field. `insertText` goes through the browser's
 * editing pipeline, so React's `onChange` fires and undo works.
 */
function insertIntoFocusedField(text: string): boolean {
  if (!isEditableField(document.activeElement)) return false;
  return document.execCommand('insertText', false, text);
}

/**
 * Receive dictation aimed at Voicebox's own window. When the shortcut fires
 * while a Voicebox field has focus (writing a correction, say), Rust can't
 * paste into its own webview, so it sends the text here and waits for the
 * reply to decide whether the pill shows an error.
 *
 * Call once from the main app shell.
 */
export function useInAppDictationInsert() {
  const platform = usePlatform();

  useEffect(() => {
    if (!platform.metadata.isTauri) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    listen<{ take: number; text: string }>('dictation:insert', (event) => {
      const { take, text } = event.payload;
      const inserted = insertIntoFocusedField(text);
      emit('dictation:inserted', { take, inserted }).catch(() => {});
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) => console.warn('[dictation] insert listener registration failed:', err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [platform.metadata.isTauri]);
}
