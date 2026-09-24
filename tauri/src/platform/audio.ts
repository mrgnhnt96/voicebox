import { invoke } from '@tauri-apps/api/core';
import type { PlatformAudio } from '@/platform/types';

export const tauriAudio: PlatformAudio = {
  async isSystemAudioSupported(): Promise<boolean> {
    return await invoke<boolean>('is_system_audio_supported');
  },

  async startSystemAudioCapture(maxDurationSecs: number): Promise<void> {
    await invoke('start_system_audio_capture', {
      maxDurationSecs,
    });
  },

  async stopSystemAudioCapture(): Promise<Blob> {
    const base64Data = await invoke<string>('stop_system_audio_capture');

    // Convert base64 to Blob
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return new Blob([bytes], { type: 'audio/wav' });
  },
};
