import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordingStream } from '@/lib/audio/streamingAudio';
import { useCaptureSettings } from '@/lib/hooks/useSettings';
import { convertToWav } from '@/lib/utils/audio';
import { openAudioInput } from '@/lib/utils/audioInput';
import { usePlatform } from '@/platform/PlatformContext';

interface UseAudioRecordingOptions {
  onRecordingStream?: (stream: MediaStream, context?: unknown) => Promise<RecordingStream>;
  deviceId?: string | null;
  // ``context`` is whatever was handed to ``startRecording`` for this take,
  // threaded back untouched so callers can correlate the result with the
  // recording it came from (the dictate window pairs it with the focus
  // snapshot captured at chord-start).
  onRecordingComplete?: (blob: Blob, duration?: number, context?: unknown) => void;
}

// Audio constraints for capture. Echo cancellation switches macOS to its
// voice-processing input, which delivers ~0.6s of silence after the mic
// opens and swallows the first words. Nothing plays back during capture, so
// there is no echo to cancel; Whisper handles the raw signal.
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export function useAudioRecording({
  deviceId,
  onRecordingComplete,
  onRecordingStream,
}: UseAudioRecordingOptions = {}) {
  const mountedRef = useRef(true);
  const platform = usePlatform();
  const { settings: captureSettings } = useCaptureSettings();
  const targetDeviceId = deviceId !== undefined ? deviceId : captureSettings?.input_device_id;
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingStreamRef = useRef<RecordingStream | null>(null);
  // The stream backing the current MediaRecorder; each take opens its own and
  // releases it when capture stops.
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const cancelledRef = useRef<boolean>(false);
  // Mirror of ``isRecording`` for reads inside callbacks that would otherwise
  // close over a stale render.
  const isRecordingRef = useRef(false);
  // True from ``startRecording`` entry until the recorder is actually running
  // (or has failed), so a stop that arrives mid-acquisition can be deferred.
  const startingRef = useRef(false);
  // True from MediaRecorder.stop() until onstop has snapshotted the take's
  // shared refs. React state and MediaRecorder.state both flip before onstop,
  // so without this gate a rapid next chord can clear chunks/duration/cancel
  // state out from under the recorder that is still finalising.
  const finishingRef = useRef(false);
  const pendingStopRef = useRef(false);
  // Bumped per recording so a stale recorder's ``onstop`` can tell it's no
  // longer the active one before it touches the shared stream refs.
  const recordingCounterRef = useRef(0);
  // Keeps the ref in lockstep with the state so the synchronous stop path reads
  // a fresh value without waiting for a rerender.
  const setRecording = useCallback((next: boolean) => {
    isRecordingRef.current = next;
    setIsRecording(next);
  }, []);

  // Assert that getUserMedia is reachable, mirroring the previous inline guard
  // (Tauri webviews occasionally expose ``navigator.mediaDevices`` a beat late).
  const assertMediaDevices = useCallback(async () => {
    if (typeof navigator === 'undefined') {
      throw new Error('Navigator API is not available. This might be a Tauri configuration issue.');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(
          platform.metadata.isTauri
            ? 'Microphone access is not available. Please ensure:\n1. The app has microphone permissions in System Settings (macOS: System Settings > Privacy & Security > Microphone)\n2. You restart the app after granting permissions\n3. You are using Tauri v2 with a webview that supports getUserMedia'
            : 'Microphone access is not available. Please ensure you are using a secure context (HTTPS or localhost) and that your browser has microphone permissions enabled.',
        );
      }
    }
  }, [platform.metadata.isTauri]);

  const acquireStream = useCallback(async (): Promise<MediaStream> => {
    await assertMediaDevices();
    return openAudioInput(targetDeviceId, AUDIO_CONSTRAINTS);
  }, [assertMediaDevices, targetDeviceId]);

  const startRecording = useCallback(
    async (context?: unknown) => {
      // A second chord can arrive while the first one is still waiting on
      // getUserMedia. Never create overlapping MediaRecorders on the same
      // coalesced stream; the original take will honor any deferred stop.
      if (
        startingRef.current ||
        finishingRef.current ||
        mediaRecorderRef.current?.state === 'recording'
      )
        return;
      startingRef.current = true;
      pendingStopRef.current = false;
      const recordingId = ++recordingCounterRef.current;
      try {
        setError(null);
        chunksRef.current = [];
        cancelledRef.current = false;
        setDuration(0);

        const stream = await acquireStream();
        streamRef.current = stream;

        if (!mountedRef.current) {
          stream.getTracks().forEach((track) => {
            track.stop();
          });
          startingRef.current = false;
          return;
        }
        let recordingStream: RecordingStream | undefined;

        // Create MediaRecorder with preferred MIME type
        const options: MediaRecorderOptions = {
          mimeType: 'audio/webm;codecs=opus',
        };

        // Fallback to default if webm not supported
        if (!MediaRecorder.isTypeSupported(options.mimeType!)) {
          delete options.mimeType;
        }

        const mediaRecorder = new MediaRecorder(stream, options);
        mediaRecorderRef.current = mediaRecorder;

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            chunksRef.current.push(event.data);
          }
        };

        mediaRecorder.onstop = async () => {
          // Whether this recorder is still the active one. A stale onstop (an
          // older recorder stopping after a newer startRecording) must not touch
          // the shared stream refs.
          const isCurrent = recordingCounterRef.current === recordingId;
          // Snapshot the cancellation flag and recorded duration immediately —
          // cancelRecording() clears chunks and sets cancelledRef synchronously
          // before this async handler runs, so we must check it first.
          const wasCancelled = cancelledRef.current;
          const recordedDuration = startTimeRef.current
            ? (Date.now() - startTimeRef.current) / 1000
            : undefined;

          const webmBlob = new Blob(chunksRef.current, { type: 'audio/webm' });

          // Release the device. Act on this recorder's own stream; only touch
          // the shared refs when this is still the current recording.
          stream.getTracks().forEach((track) => {
            track.stop();
          });
          if (isCurrent) streamRef.current = null;

          if (isCurrent) recordingStreamRef.current = null;
          if (wasCancelled) recordingStream?.cancel();
          else await recordingStream?.stop(recordedDuration).catch(() => recordingStream?.cancel());

          // All shared per-take refs have now been snapshotted and stream
          // cleanup is complete. A new take may begin while WAV conversion and
          // upload continue using the local values above.
          finishingRef.current = false;

          // Don't fire completion callback if the recording was cancelled
          if (wasCancelled || !mountedRef.current) return;

          // Convert to WAV format to avoid needing ffmpeg on backend
          try {
            const wavBlob = await convertToWav(webmBlob);
            onRecordingComplete?.(wavBlob, recordedDuration, context);
          } catch (err) {
            console.error('Error converting audio to WAV:', err);
            // Fallback to original blob if conversion fails
            onRecordingComplete?.(webmBlob, recordedDuration, context);
          }
        };

        mediaRecorder.onerror = (event) => {
          setError('Recording error occurred');
          console.error('MediaRecorder error:', event);
        };

        // WebKit's MediaRecorder drops the WebM EBML header from chunks when
        // started with a timeslice, so concatenated blobs fail to parse in
        // both AudioContext and ffmpeg. Starting with no timeslice produces
        // exactly one dataavailable on stop() with a valid container.
        mediaRecorder.start();
        // The optional PCM processor must never delay capturing the first words.
        // If setup finishes after stop/unmount, discard it and use the archive.
        void onRecordingStream?.(stream, context)
          .then((sidecar) => {
            if (
              !mountedRef.current ||
              mediaRecorder.state !== 'recording' ||
              cancelledRef.current
            ) {
              sidecar.cancel();
              return;
            }
            recordingStream = sidecar;
            recordingStreamRef.current = sidecar;
          })
          .catch(() => {
            // Streaming is optional; the full recording remains available.
          });
        setRecording(true);
        startTimeRef.current = Date.now();
        startingRef.current = false;

        // A stop (chord release) that landed while the mic was still opening —
        // honor it now that capture has actually begun.
        if (pendingStopRef.current) {
          pendingStopRef.current = false;
          finishingRef.current = true;
          mediaRecorder.stop();
          setRecording(false);
          return;
        }

        // Start timer
        timerRef.current = window.setInterval(() => {
          if (startTimeRef.current) {
            const elapsed = (Date.now() - startTimeRef.current) / 1000;
            setDuration(elapsed);
          }
        }, 100);
      } catch (err) {
        const errorMessage =
          err instanceof Error
            ? err.message
            : 'Failed to access microphone. Please check permissions.';
        // Release a stream opened before the failure so the mic doesn't stay lit.
        streamRef.current?.getTracks().forEach((track) => {
          track.stop();
        });
        streamRef.current = null;
        recordingStreamRef.current?.cancel();
        recordingStreamRef.current = null;
        startingRef.current = false;
        finishingRef.current = false;
        pendingStopRef.current = false;
        setError(errorMessage);
        setRecording(false);
      }
    },
    [onRecordingComplete, onRecordingStream, acquireStream, setRecording],
  );

  const stopRecording = useCallback(() => {
    // The recorder's own state is the lifecycle authority — React ``isRecording``
    // lags a render behind ``mediaRecorder.start()``, so a chord release in that
    // window would otherwise be dropped.
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === 'recording') {
      finishingRef.current = true;
      recorder.stop();
      setRecording(false);

      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    } else if (startingRef.current) {
      // Stop arrived before capture began (mic still opening) — defer it so
      // startRecording stops as soon as the recorder goes live.
      pendingStopRef.current = true;
    }
  }, [setRecording]);

  const cancelRecording = useCallback(() => {
    recordingStreamRef.current?.cancel();
    cancelledRef.current = true; // Must be set before stop() triggers onstop
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      chunksRef.current = [];
      finishingRef.current = true;
      recorder.stop();
      setRecording(false);
      setDuration(0);
    } else if (startingRef.current) {
      // Cancel during mic acquisition — stop as soon as capture begins; the
      // cancelled flag suppresses the completion callback.
      pendingStopRef.current = true;
    }

    // Release the mic immediately.
    streamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    streamRef.current = null;

    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, [setRecording]);

  // Cleanup on unmount — always fully release the device. A stream still being
  // acquired is stopped by startRecording once it sees the hook unmounted.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelledRef.current = true;
      recordingStreamRef.current?.cancel();
      if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
      }
      streamRef.current?.getTracks().forEach((track) => {
        track.stop();
      });
    };
  }, []);

  return {
    isRecording,
    duration,
    error,
    canStartRecording: () =>
      !startingRef.current && !finishingRef.current && !isRecordingRef.current,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
