/** A PCM sidecar; MediaRecorder remains responsible for the archival recording. */
export interface RecordingStream {
  stop: (duration?: number) => Promise<void>;
  cancel: () => void;
  coversStart?: boolean;
}

const processorSource = `
class CapturePCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(2048);
    this.length = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'stop') {
        this.flush();
        this.stopped = true;
        this.port.postMessage('stopped');
      }
    };
  }
  flush() {
    if (!this.length) return;
    const frame = this.buffer.slice(0, this.length);
    this.port.postMessage(frame.buffer, [frame.buffer]);
    this.length = 0;
  }
  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      this.buffer[this.length++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
      if (this.length === this.buffer.length) this.flush();
    }
    return true;
  }
}
registerProcessor('capture-pcm', CapturePCM);
`;

// One processor module per webview. Keeping an unconnected audio context alive
// does not hold a microphone; the recorder still owns device acquisition/release.
let prepared: { context: AudioContext; ready: Promise<void>; loaded: boolean } | undefined;

export function prepareStreamingAudio(): Promise<void> {
  if (prepared && prepared.context.state !== 'closed') return prepared.ready;
  try {
    const context = new AudioContext();
    const moduleUrl = URL.createObjectURL(new Blob([processorSource], { type: 'text/javascript' }));
    const entry = { context, ready: Promise.resolve(), loaded: false };
    prepared = entry;
    let timer: ReturnType<typeof setTimeout> | undefined;
    entry.ready = Promise.race([
      context.audioWorklet.addModule(moduleUrl),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Audio streaming setup timed out')), 3000);
      }),
    ])
      .then(() => {
        entry.loaded = true;
      })
      .catch((error) => {
        if (prepared === entry) prepared = undefined;
        void context.close().catch(() => {});
        throw error;
      })
      .finally(() => {
        clearTimeout(timer);
        URL.revokeObjectURL(moduleUrl);
      });
    return entry.ready;
  } catch (error) {
    return Promise.reject(error);
  }
}

export async function startStreamingAudio(
  stream: MediaStream,
  onStart: (sampleRate: number) => void,
  onFrame: (frame: ArrayBuffer) => void,
  onFailure?: () => void,
): Promise<RecordingStream> {
  const coversStart = !!prepared?.loaded && prepared.context.state === 'running';
  if (!prepared?.loaded || prepared.context.state === 'closed') await prepareStreamingAudio();
  const context = prepared!.context;
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: AudioWorkletNode | undefined;
  let closed = false;
  const close = () => {
    closed = true;
    source?.disconnect();
    processor?.disconnect();
    processor?.port.close();
  };
  try {
    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (context.state !== 'running')
        await Promise.race([
          (async () => {
            if (context.state !== 'running' && !closed) await context.resume();
          })(),
          new Promise<never>((_, reject) => {
            setupTimer = setTimeout(
              () => reject(new Error('Audio streaming setup timed out')),
              3000,
            );
          }),
        ]);
    } finally {
      clearTimeout(setupTimer);
    }
    onStart(context.sampleRate);
    source = context.createMediaStreamSource(stream);
    processor = new AudioWorkletNode(context, 'capture-pcm');
    processor.onprocessorerror = () => {
      close();
      onFailure?.();
    };
    let stopped: (() => void) | undefined;
    processor.port.onmessage = ({ data }: MessageEvent<ArrayBuffer | string>) => {
      if (closed) return;
      if (data === 'stopped') stopped?.();
      else if (data instanceof ArrayBuffer) onFrame(data);
    };
    source.connect(processor);
    // The processor's output is silence; connecting keeps WebKit's graph active.
    processor.connect(context.destination);
    return {
      coversStart,
      cancel: close,
      stop: () =>
        new Promise<void>((resolve, reject) => {
          if (closed) {
            resolve();
            return;
          }
          const timeout = setTimeout(() => {
            close();
            reject(new Error('Audio streaming flush timed out'));
          }, 2000);
          stopped = () => {
            clearTimeout(timeout);
            close();
            resolve();
          };
          processor!.port.postMessage('stop');
        }),
    };
  } catch (error) {
    close();
    throw error;
  }
}
