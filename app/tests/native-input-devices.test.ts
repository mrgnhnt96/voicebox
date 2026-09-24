import { beforeEach, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

const invoke = mock(async (_command: string, _args?: unknown) => [] as unknown);
mock.module('@tauri-apps/api/core', () => ({ invoke }));

const { useNativeInputDevices, inputDevicePickerValue } = await import(
  '../src/lib/hooks/useNativeInputDevices'
);

beforeEach(() => {
  invoke.mockClear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

test('lists native microphones with their stable ids', async () => {
  invoke.mockImplementation(async () => [
    { id: 'native:MacBook Pro Microphone', name: 'MacBook Pro Microphone', is_default: true },
    { id: 'native:AirPods', name: 'AirPods', is_default: false },
  ]);
  let result: ReturnType<typeof useNativeInputDevices> | undefined;
  function Harness({ enabled }: { enabled: boolean }) {
    result = useNativeInputDevices(enabled);
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(createElement(Harness, { enabled: true }));
  });
  expect(invoke).toHaveBeenCalledWith('list_input_devices');
  expect(result?.devices).toEqual([
    { deviceId: 'native:MacBook Pro Microphone', label: 'MacBook Pro Microphone' },
    { deviceId: 'native:AirPods', label: 'AirPods' },
  ]);
  await act(async () => renderer?.unmount());
});

test('does nothing outside the desktop app', async () => {
  function Harness() {
    useNativeInputDevices(false);
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(createElement(Harness));
  });
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => renderer?.unmount());
});

test('browser recording resolves a saved native microphone by its label', async () => {
  const { openAudioInput } = await import('../src/lib/utils/audioInput');
  const getUserMedia = mock(async (_constraints: MediaStreamConstraints) => ({}));
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia,
        enumerateDevices: async () => [
          { kind: 'audiooutput', deviceId: 'speaker', label: 'AirPods' },
          { kind: 'audioinput', deviceId: 'webkit-airpods', label: 'AirPods' },
        ],
      },
    },
  });
  await openAudioInput('native:AirPods');
  expect(getUserMedia.mock.calls[0][0]).toEqual({
    audio: { deviceId: { exact: 'webkit-airpods' } },
  });
  getUserMedia.mockClear();
  await openAudioInput('native:Unplugged');
  expect(getUserMedia.mock.calls).toEqual([[{ audio: {} }]]);
});

test('a saved device that is not listed shows as the system default', () => {
  const devices = [{ deviceId: 'native:AirPods', label: 'AirPods' }];
  expect(inputDevicePickerValue('native:AirPods', devices)).toBe('native:AirPods');
  // A legacy WebKit id, or an unplugged microphone: capture uses the default.
  expect(inputDevicePickerValue('3f9a0c1d', devices)).toBe('default');
  expect(inputDevicePickerValue(null, devices)).toBe('default');
});
