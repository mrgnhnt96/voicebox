import { afterEach, beforeEach, expect, test } from 'bun:test';
import { CaptureStream } from '../src/lib/api/captureStream';

class Socket {
  static OPEN = 1;
  static latest: Socket;
  readyState = 1;
  bufferedAmount = 0;
  sent: (string | ArrayBuffer)[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(public url: URL) {
    Socket.latest = this;
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  event(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}
const originalSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;
let stream: CaptureStream;
const finalEvent = {
  type: 'final',
  refinement_complete: true,
  capture: { id: 'session', transcript_raw: '', transcript_refined: '', allow_auto_paste: false },
};
beforeEach(() => {
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  stream = new CaptureStream('https://example.com', 48000);
});
afterEach(() => {
  stream.cancel();
  globalThis.WebSocket = originalSocket;
  globalThis.fetch = originalFetch;
});
test('buffers PCM until ready with sequence and sample offset headers', () => {
  const socket = Socket.latest;
  socket.onopen?.();
  expect(socket.url.toString()).toBe('wss://example.com/captures/stream');
  expect(JSON.parse(socket.sent[0] as string).sample_rate).toBe(48000);
  stream.append(new Int16Array([1, -2]).buffer);
  stream.append(new Int16Array([3]).buffer);
  expect(socket.sent).toHaveLength(1);
  socket.event({ type: 'ready', session_id: 'session' });
  const first = new DataView(socket.sent[1] as ArrayBuffer);
  const second = new DataView(socket.sent[2] as ArrayBuffer);
  expect(first.getUint32(0, true)).toBe(0);
  expect(first.getInt16(10, true)).toBe(-2);
  expect(second.getUint32(0, true)).toBe(1);
  expect(second.getUint32(4, true)).toBe(2);
});
test('disconnect before finish permits batch fallback', async () => {
  Socket.latest.close();
  expect(await stream.finish()).toBeNull();
});
test('finish sends once and retains empty final output', async () => {
  Socket.latest.event({ type: 'ready', session_id: 'session' });
  const first = stream.finish();
  expect(stream.finish()).toBe(first);
  await Promise.resolve();
  Socket.latest.event(finalEvent);
  expect((await first)?.capture.transcript_refined).toBe('');
  expect(
    Socket.latest.sent.filter(
      (value) => typeof value === 'string' && JSON.parse(value).type === 'finish',
    ),
  ).toHaveLength(1);
});
test('post-finish disconnect recovers final without batch retry', async () => {
  let recoveredUrl = '';
  globalThis.fetch = (async (url: string) => {
    recoveredUrl = url;
    return new Response(JSON.stringify(finalEvent), { status: 200 });
  }) as typeof fetch;
  Socket.latest.event({ type: 'ready', session_id: 'session' });
  const result = stream.finish();
  await Promise.resolve();
  Socket.latest.close();
  expect((await result)?.capture.id).toBe('session');
  expect(recoveredUrl).toBe('https://example.com/captures/stream/session/result');
});
test('slow socket consumer switches to batch before finish', async () => {
  Socket.latest.event({ type: 'ready', session_id: 'session' });
  Socket.latest.bufferedAmount = 1024 * 1024;
  stream.append(new Int16Array([1]).buffer);
  expect(await stream.finish()).toBeNull();
});

test('explicit cancellation after finish does not recover or deliver', async () => {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return new Response(JSON.stringify(finalEvent));
  }) as typeof fetch;
  Socket.latest.event({ type: 'ready', session_id: 'session' });
  const result = stream.finish();
  await Promise.resolve();
  stream.cancel();
  expect(await result).toBeNull();
  expect(requests).toBe(0);
});

test('retained terminal errors surface immediately without duplicate capture', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        type: 'error',
        session_id: 'session',
        message: 'Recognition failed',
      }),
    )) as typeof fetch;
  Socket.latest.event({ type: 'ready', session_id: 'session' });
  const result = stream.finish();
  await Promise.resolve();
  Socket.latest.close();
  await expect(result).rejects.toThrow('Recognition failed');
});
