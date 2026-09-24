import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';
import type { AudioInputDevice } from '@/lib/hooks/useAudioInputDevices';

interface NativeInputDevice {
  id: string;
  name: string;
  is_default: boolean;
}

/**
 * Microphones as the desktop app's native capture sees them. Ids look like
 * ``native:<device name>`` and are what dictation stores in
 * ``input_device_id``; Rust falls back to the system default when the saved
 * device is missing. ``enabled`` is false outside Tauri.
 */
export function useNativeInputDevices(enabled: boolean): {
  devices: AudioInputDevice[];
  refreshDevices: () => void;
} {
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);

  const refreshDevices = useCallback(() => {
    if (!enabled) return;
    invoke<NativeInputDevice[]>('list_input_devices')
      .then((list) => setDevices(list.map((d) => ({ deviceId: d.id, label: d.name }))))
      .catch((err) => {
        console.error('Failed to list native input devices:', err);
        setDevices([]);
      });
  }, [enabled]);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  return { devices, refreshDevices };
}

/** Picker value for a saved id: unknown or legacy ids show as the default. */
export function inputDevicePickerValue(
  savedId: string | null,
  devices: AudioInputDevice[],
): string {
  return savedId && devices.some((d) => d.deviceId === savedId) ? savedId : 'default';
}
