import { Loader2, Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { debug } from '@/lib/utils/debug';
import { formatDuration } from './captureFormat';

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
      waveColor: cssHsla('--muted-foreground', 0.45),
      progressColor: cssHsla('--accent', 1),
      cursorColor: 'transparent',
      barWidth: 3,
      barRadius: 1,
      barGap: 2,
      height: 32,
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
    <div className={cn('flex items-center gap-3', className)}>
      <Button
        size="icon"
        variant="outline"
        className="h-8 w-8 shrink-0 bg-popover [&_svg]:size-3"
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
      <div className="flex-1 min-w-0 h-11 flex items-center gap-3 px-2.5 rounded-md border border-border bg-card">
        <div ref={waveformRef} className="flex-1 min-w-0 h-8 select-none" />
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground shrink-0">
          {error ? '—' : formatDuration(displayMs)}
        </span>
      </div>
    </div>
  );
}
