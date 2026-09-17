import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { openAudioInput } from '../src/lib/utils/audioInput';

let settings = { input_device_id: null as string | null };
const convert = mock(async (blob: Blob) => blob);
mock.module('../src/platform/PlatformContext', () => ({
  usePlatform: () => ({ metadata: { isTauri: false } }),
}));
mock.module('../src/lib/hooks/useSettings', () => ({ useCaptureSettings: () => ({ settings }) }));
mock.module('../src/lib/utils/audio', () => ({ convertToWav: convert }));
const { useAudioRecording } = await import('../src/lib/hooks/useAudioRecording');

let hook: ReturnType<typeof useAudioRecording>;
let renderer: ReturnType<typeof create>;
let options: Parameters<typeof useAudioRecording>[0];
let getUserMedia: ReturnType<typeof mock>;
const streams: ReturnType<typeof makeStream>[] = [];
function makeStream() {
  const track = {
    readyState: 'live',
    stop: mock(() => {
      track.readyState = 'ended';
    }),
  };
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}
class Recorder {
  static instances: Recorder[] = [];
  static isTypeSupported() {
    return true;
  }
  state = 'inactive';
  onstop?: () => void;
  ondataavailable?: (event: { data: Blob }) => void;
  constructor() {
    Recorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['speech']) });
      this.onstop?.();
    });
  }
}
function Harness() {
  hook = useAudioRecording(options);
  return null;
}
async function mount(value = {}) {
  options = value;
  await act(async () => {
    renderer = create(createElement(Harness));
  });
}
beforeEach(() => {
  settings = { input_device_id: null };
  Recorder.instances = [];
  streams.length = 0;
  convert.mockImplementation(async (blob) => blob);
  getUserMedia = mock(async () => {
    const stream = makeStream();
    streams.push(stream);
    return stream;
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia } },
  });
  Object.assign(globalThis, { window: globalThis, MediaRecorder: Recorder });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

test('a quick release while permission is pending stops the eventual recorder', async () => {
  let resolve!: (stream: ReturnType<typeof makeStream>) => void;
  getUserMedia.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const complete = mock();
  await mount({ onRecordingComplete: complete });
  let start!: Promise<void>;
  await act(async () => {
    start = hook.startRecording('target-A');
  });
  await act(async () => {
    hook.stopRecording();
    resolve(makeStream());
    await start;
  });
  expect(hook.isRecording).toBe(false);
  expect(Recorder.instances).toHaveLength(1);
  expect(Recorder.instances[0].state).toBe('inactive');
  expect(complete.mock.calls[0][2]).toBe('target-A');
});

test('unmount during microphone acquisition releases the late stream', async () => {
  let resolve!: (stream: ReturnType<typeof makeStream>) => void;
  getUserMedia.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await mount({ keepWarm: true });
  let warming!: Promise<void>;
  await act(async () => {
    warming = hook.prewarm();
  });
  await act(async () => renderer.unmount());
  const stream = makeStream();
  resolve(stream);
  await warming;
  expect(stream.getTracks()[0].stop).toHaveBeenCalledTimes(1);
});

test('changing devices retains an active take then opens the selected mic', async () => {
  await mount({ keepWarm: true });
  await act(async () => hook.startRecording('A'));
  const original = streams[0];
  settings = { input_device_id: 'usb' };
  await act(async () => renderer.update(createElement(Harness)));
  expect(original.getTracks()[0].readyState).toBe('live');
  await act(async () => hook.stopRecording());
  expect(original.getTracks()[0].readyState).toBe('ended');
  await act(async () => hook.startRecording('B'));
  expect(getUserMedia.mock.calls[1][0].audio.deviceId).toEqual({ exact: 'usb' });
  await act(async () => hook.stopRecording());
});

test('each delayed conversion keeps the focus context of its own take', async () => {
  const resolvers: (() => void)[] = [];
  convert.mockImplementation(
    (blob) => new Promise((resolve) => resolvers.push(() => resolve(blob))),
  );
  const complete = mock();
  await mount({ onRecordingComplete: complete });
  await act(async () => hook.startRecording('A'));
  await act(async () => hook.stopRecording());
  await act(async () => hook.startRecording('B'));
  await act(async () => hook.stopRecording());
  await act(async () => {
    resolvers[1]();
    resolvers[0]();
  });
  expect(complete.mock.calls.map((call) => call[2])).toEqual(['B', 'A']);
});

test('missing selected microphone falls back to system default', async () => {
  getUserMedia.mockRejectedValueOnce(new DOMException('missing', 'OverconstrainedError'));
  await openAudioInput('unplugged');
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  expect(getUserMedia.mock.calls[1][0]).toEqual({ audio: {} });
});

test('permission denial is propagated without a second microphone request', async () => {
  getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
  await expect(openAudioInput('usb')).rejects.toThrow('denied');
  expect(getUserMedia).toHaveBeenCalledTimes(1);
});

test('warmup and rapid repeated starts share one acquisition and one recorder', async () => {
  let resolve!: (stream: ReturnType<typeof makeStream>) => void;
  getUserMedia.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await mount({ keepWarm: true });
  let warming!: Promise<void>;
  let start!: Promise<void>;
  await act(async () => {
    warming = hook.prewarm();
    start = hook.startRecording('A');
    await hook.startRecording('B');
  });
  await act(async () => {
    resolve(makeStream());
    await Promise.all([warming, start]);
  });
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(Recorder.instances).toHaveLength(1);
  await act(async () => hook.stopRecording());
});

test('cancel during permission acquisition never delivers speech', async () => {
  let resolve!: (stream: ReturnType<typeof makeStream>) => void;
  getUserMedia.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const complete = mock();
  await mount({ onRecordingComplete: complete });
  let start!: Promise<void>;
  await act(async () => {
    start = hook.startRecording('A');
  });
  const stream = makeStream();
  await act(async () => {
    hook.cancelRecording();
    resolve(stream);
    await start;
  });
  expect(complete).not.toHaveBeenCalled();
  expect(stream.getTracks()[0].readyState).toBe('ended');
});

test('known denied microphone permission prevents requesting a stream', async () => {
  Object.assign(navigator, { permissions: { query: mock(async () => ({ state: 'denied' })) } });
  await expect(openAudioInput()).rejects.toThrow('Microphone permission');
  expect(getUserMedia).not.toHaveBeenCalled();
});

const createCapture = mock();
const refineCapture = mock();
mock.module('../src/lib/api/client', () => ({
  apiClient: {
    createCapture,
    refineCapture,
    pauseLearningForRecording: mock(async () => {}),
  },
}));
mock.module('@tauri-apps/api/event', () => ({ emit: mock(async () => {}) }));
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useCaptureRecordingSession } = await import('../src/lib/hooks/useCaptureRecordingSession');
let session: ReturnType<typeof useCaptureRecordingSession>;
let sessionOptions = {};
function SessionHarness() {
  session = useCaptureRecordingSession(sessionOptions);
  return null;
}
async function mountSession(value = {}) {
  sessionOptions = value;
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  await act(async () => {
    renderer = create(
      createElement(QueryClientProvider, { client }, createElement(SessionHarness)),
    );
  });
}

test('pending or denied permission never displays recording', async () => {
  let reject!: (error: Error) => void;
  getUserMedia.mockImplementation(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  await mountSession();
  await act(async () => session.startRecording());
  expect(session.pillState).not.toBe('recording');
  await act(async () => {
    reject(new DOMException('Microphone denied', 'NotAllowedError'));
  });
  expect(session.pillState).toBe('error');
  expect(Recorder.instances).toHaveLength(0);
});

test('paste failures surface as errors instead of silently completing', async () => {
  createCapture.mockResolvedValue({
    id: 'take',
    auto_refine: false,
    allow_auto_paste: true,
    transcript_raw: 'Hello.',
  });
  await mountSession({
    onFinalText: async () => {
      throw new Error('Accessibility permission required');
    },
  });
  await act(async () => {
    session.uploadFile(new File(['audio'], 'test.wav'), 'file');
  });
  expect(session.pillState).toBe('error');
  expect(session.errorMessage).toContain('Accessibility permission required');
});

test('streaming flush starts finalization before archival WAV conversion', async () => {
  const order: string[] = [];
  convert.mockImplementation(async (blob) => {
    order.push('convert');
    return blob;
  });
  await mount({
    onRecordingStream: async () => ({
      stop: async () => {
        order.push('flush');
      },
      cancel: mock(),
    }),
    onRecordingComplete: () => order.push('complete'),
  });
  await act(async () => hook.startRecording());
  await act(async () => hook.stopRecording());
  expect(order).toEqual(['flush', 'convert', 'complete']);
});

test('streaming initialization failure preserves full recording completion', async () => {
  const complete = mock();
  await mount({
    onRecordingStream: async () => {
      throw new Error('AudioWorklet unavailable');
    },
    onRecordingComplete: complete,
  });
  await act(async () => hook.startRecording());
  await act(async () => hook.stopRecording());
  expect(complete).toHaveBeenCalledTimes(1);
});

test('unmount during streaming setup cancels the late sidecar and releases mic', async () => {
  let resolve!: (value: { stop: () => Promise<void>; cancel: () => void }) => void;
  const cancel = mock();
  await mount({
    onRecordingStream: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  let start!: Promise<void>;
  await act(async () => {
    start = hook.startRecording();
  });
  await act(async () => renderer.unmount());
  resolve({ stop: async () => {}, cancel });
  await start;
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(streams[0].getTracks()[0].readyState).toBe('ended');
  expect(Recorder.instances).toHaveLength(0);
});

test('delayed completion of the prior take cannot replace the current recording pill', async () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  let resolve!: (blob: Blob) => void;
  convert.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const delivered = mock();
  createCapture.mockResolvedValue({
    id: 'previous',
    auto_refine: false,
    allow_auto_paste: true,
    transcript_raw: 'First take.',
  });
  try {
    await mountSession({ onFinalText: delivered });
    await act(async () => session.startRecording('first-target'));
    now += 600;
    await act(async () => session.stopRecording());
    await act(async () => session.startRecording('second-target'));
    expect(session.pillState).toBe('recording');
    await act(async () => {
      resolve(new Blob(['wav'], { type: 'audio/wav' }));
      await new Promise((done) => setTimeout(done, 10));
    });
    expect(session.pillState).toBe('recording');
    expect(delivered.mock.calls[0][3]).toBe('first-target');
  } finally {
    Date.now = originalNow;
  }
});

test('recorder rejects a new take until the PCM tail has flushed', async () => {
  let finish!: () => void;
  await mount({
    onRecordingStream: async () => ({
      stop: () =>
        new Promise<void>((r) => {
          finish = r;
        }),
      cancel: mock(),
    }),
  });
  await act(async () => hook.startRecording());
  await act(async () => hook.stopRecording());
  expect(hook.canStartRecording()).toBe(false);
  await act(async () => finish());
  expect(hook.canStartRecording()).toBe(true);
});

test('empty refined output completes without pasting raw text or replacing a selection', async () => {
  const capture = {
    id: 'empty-refinement',
    auto_refine: true,
    allow_auto_paste: true,
    transcript_raw: 'remove that',
    transcript_refined: '',
  };
  createCapture.mockResolvedValue({ ...capture, transcript_refined: null });
  refineCapture.mockResolvedValue(capture);
  const deliver = mock();
  await mountSession({ onFinalText: deliver });
  await act(async () => {
    session.uploadFile(new File(['audio'], 'empty.wav'), 'file');
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(refineCapture).toHaveBeenCalledWith('empty-refinement', {});
  expect(deliver).not.toHaveBeenCalled();
  expect(session.pillState).toBe('rest');
  expect(session.errorMessage).toBeNull();
});
