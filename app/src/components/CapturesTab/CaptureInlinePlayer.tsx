import { Loader2, Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { debug } from '@/lib/utils/debug';
import { formatDuration } from './captureFormat';

/** The capture's audio as a small pill: play, a scrubbable waveform, and the time. */
export function CaptureInlinePlayer({
  audioUrl,
  fallbackDurationMs,
  className,
}: {
  audioUrl: string;
  fallbackDurationMs?: number | null;
  className?: string;
}) {
  const waveformRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = waveformRef.current;
    if (!container) return;

    const root = document.documentElement;
    const cssHsla = (varName: string, alpha: number) => {
      const value = getComputedStyle(root).getPropertyValue(varName).trim();
      if (!value) return '';
      const [h, s, l] = value.split(/\s+/);
      if (!h || !s || !l) return '';
      return `hsla(${h}, ${s}, ${l}, ${alpha})`;
    };

    const ws = WaveSurfer.create({
      container,
      waveColor: cssHsla('--muted-foreground', 0.55),
      progressColor: cssHsla('--accent', 1),
      cursorColor: 'transparent',
      barWidth: 2,
      barRadius: 1,
      barGap: 2,
      height: 18,
      normalize: true,
      interact: true,
      dragToSeek: { debounceTime: 0 },
      mediaControls: false,
      backend: 'WebAudio',
    });

    ws.on('ready', () => {
      setDuration(ws.getDuration());
      setIsLoading(false);
      setError(null);
    });
    ws.on('play', () => setIsPlaying(true));
    ws.on('pause', () => setIsPlaying(false));
    ws.on('finish', () => {
      setIsPlaying(false);
      setCurrentTime(ws.getDuration());
    });
    ws.on('timeupdate', (t) => setCurrentTime(t));
    ws.on('seeking', (t) => setCurrentTime(t));
    ws.on('error', (err) => {
      debug.error('Inline waveform error', err);
      setError(err instanceof Error ? err.message : String(err));
      setIsLoading(false);
    });

    wavesurferRef.current = ws;

    return () => {
      try {
        ws.destroy();
      } catch (err) {
        debug.error('Failed to destroy inline waveform', err);
      }
      wavesurferRef.current = null;
    };
  }, []);

  useEffect(() => {
    const ws = wavesurferRef.current;
    if (!ws) return;
    setIsLoading(true);
    setError(null);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    try {
      if (ws.isPlaying()) ws.pause();
      ws.seekTo(0);
    } catch (err) {
      debug.error('Failed to reset inline waveform before load', err);
    }
    ws.load(audioUrl).catch((err) => {
      debug.error('Inline waveform load failed', err);
      setError(err instanceof Error ? err.message : String(err));
      setIsLoading(false);
    });
  }, [audioUrl]);

  const handlePlayPause = () => {
    const ws = wavesurferRef.current;
    if (!ws || isLoading) return;
    if (ws.isPlaying()) {
      ws.pause();
    } else {
      // The WebAudio backend's context is created on mount, outside a user
      // gesture, and WebKit leaves it suspended (or interrupted after the
      // mic is used), so playing it stays silent until it is resumed here.
      const { audioContext } = ws.getMediaElement() as unknown as { audioContext?: AudioContext };
      const resumed =
        audioContext && audioContext.state !== 'running'
          ? audioContext.resume()
          : Promise.resolve();
      resumed
        .then(() => ws.play())
        .catch((err) => {
          debug.error('Inline play failed', err);
          setError(err instanceof Error ? err.message : String(err));
        });
    }
  };

  const displayMs =
    duration > 0
      ? Math.round((isPlaying || currentTime > 0 ? currentTime : duration) * 1000)
      : (fallbackDurationMs ?? 0);

  return (
    <div
      className={cn(
        'flex h-9 items-center gap-2.5 rounded-full border border-border bg-card pl-1 pr-3',
        className,
      )}
    >
      <Button
        size="icon"
        className="h-7 w-7 shrink-0 rounded-full bg-accent text-accent-foreground hover:bg-accent/90 [&_svg]:size-3"
        onClick={handlePlayPause}
        disabled={isLoading || !!error}
        aria-label={isPlaying ? 'Pause recording' : 'Play recording'}
      >
        {isLoading ? (
          <Loader2 className="animate-spin" />
        ) : isPlaying ? (
          <Pause className="fill-current" />
        ) : (
          <Play className="ml-px fill-current" />
        )}
      </Button>
      <div ref={waveformRef} className="flex-1 min-w-0 h-[18px] select-none" />
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground shrink-0">
        {error ? '—' : formatDuration(displayMs)}
      </span>
    </div>
  );
}
