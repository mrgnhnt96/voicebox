import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

type Handler = (event: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();
const unlisten = mock(() => {});
const invoke = mock(async (_command: string, _args?: unknown) => undefined as unknown);
let settings: { input_device_id: string | null } | undefined = { input_device_id: null };

mock.module('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: Handler) => {
    handlers.set(name, handler);
    return unlisten;
  },
  emit: async () => {},
}));
mock.module('@tauri-apps/api/core', () => ({ invoke }));
mock.module('../src/lib/hooks/useSettings', () => ({ useCaptureSettings: () => ({ settings }) }));
// bun shares module mocks across test files: keep the store's full surface.
const serverState = { serverUrl: 'http://127.0.0.1:17493' };
mock.module('../src/stores/serverStore', () => ({
  useServerStore: Object.assign(
    (select: (state: typeof serverState) => unknown) => select(serverState),
    { getState: () => serverState },
  ),
}));

const { useNativeDictationSession } = await import('../src/lib/hooks/useNativeDictationSession');

let hook: ReturnType<typeof useNativeDictationSession>;
let renderer: ReturnType<typeof create> | undefined;

function Harness() {
  hook = useNativeDictationSession();
  return null;
}

async function mount() {
  await act(async () => {
    renderer = create(createElement(Harness));
  });
}

async function send(payload: Record<string, unknown>) {
  await act(async () => {
    handlers.get('dictation:state')?.({ payload });
  });
}

beforeEach(() => {
  handlers.clear();
  invoke.mockClear();
  unlisten.mockClear();
  settings = { input_device_id: null };
  Object.assign(globalThis, {
    window: Object.assign(globalThis, { location: { origin: 'tauri://localhost' } }),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
});

test('pushes the server, origin and saved native microphone to Rust', async () => {
  settings = { input_device_id: 'native:AirPods' };
  await mount();
  expect(invoke).toHaveBeenCalledWith('dictation_configure', {
    serverUrl: 'http://127.0.0.1:17493',
    origin: 'tauri://localhost',
    inputDeviceId: 'native:AirPods',
  });
});

test('never opens browser audio for dictation', async () => {
  const getUserMedia = mock(async () => ({}));
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia } },
  });
  await mount();
  await send({ take: 1, state: 'preparing' });
  await send({ take: 1, state: 'recording' });
  expect(getUserMedia).not.toHaveBeenCalled();
});

test('follows the native take through the pill states', async () => {
  await mount();
  expect(hook.pillState).toBe('hidden');
  await send({ take: 1, state: 'preparing' });
  expect(hook.pillState).toBe('preparing');
  expect(hook.isRecording).toBe(true);
  await send({ take: 1, state: 'recording' });
  expect(hook.pillState).toBe('recording');
  await send({ take: 1, state: 'transcribing', elapsed_ms: 2400 });
  expect(hook.pillState).toBe('transcribing');
  expect(hook.pillElapsedMs).toBe(2400);
  expect(hook.isRecording).toBe(false);
  await send({ take: 1, state: 'refining' });
  expect(hook.pillState).toBe('refining');
  await send({ take: 1, state: 'done' });
  expect(hook.pillState).toBe('rest');
});

test('errors show their message for the requested time', async () => {
  await mount();
  await send({ take: 1, state: 'preparing' });
  await send({
    take: 1,
    state: 'error',
    message: 'Recording too short, canceled',
    visible_ms: 2000,
  });
  expect(hook.pillState).toBe('error');
  expect(hook.errorMessage).toBe('Recording too short, canceled');
  await act(async () => hook.dismissError());
  expect(hook.pillState).toBe('hidden');
  expect(hook.errorMessage).toBeNull();
});

test('a finishing older take cannot overwrite a newer recording', async () => {
  await mount();
  await send({ take: 1, state: 'preparing' });
  await send({ take: 1, state: 'transcribing', elapsed_ms: 1000 });
  await send({ take: 2, state: 'preparing' });
  await send({ take: 2, state: 'recording' });
  await send({ take: 1, state: 'done' });
  await send({ take: 1, state: 'error', message: 'late', visible_ms: 6000 });
  expect(hook.pillState).toBe('recording');
  expect(hook.errorMessage).toBeNull();
});

test('the pill stop button stops the native take', async () => {
  await mount();
  await send({ take: 1, state: 'preparing' });
  await act(async () => hook.stopRecording());
  expect(invoke.mock.calls.map((call) => call[0])).toContain('dictation_stop');
});

test('unmount releases the event listener', async () => {
  await mount();
  await act(async () => renderer?.unmount());
  renderer = undefined;
  expect(unlisten).toHaveBeenCalled();
});
