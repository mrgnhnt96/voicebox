import type { ReactNode } from 'react';
import { useDictationReadiness } from '@/lib/hooks/useDictationReadiness';
import { useNativeInputDevices } from '@/lib/hooks/useNativeInputDevices';
import { useServerHealth } from '@/lib/hooks/useServer';
import { useCaptureSettings } from '@/lib/hooks/useSettings';
import { useWritingStyle } from '@/lib/hooks/useWritingStyle';
import { cn } from '@/lib/utils/cn';
import { usePlatform } from '@/platform/PlatformContext';

/**
 * The always-on status line at the bottom of the window: server, models,
 * microphone, permissions and what Voicebox has learned. Replaces the
 * timer, model names and hints the old pill carried.
 */
export function StatusBar() {
  const platform = usePlatform();
  const isTauri = platform.metadata.isTauri;
  const health = useServerHealth();
  const readiness = useDictationReadiness();
  const { settings } = useCaptureSettings();
  const { devices } = useNativeInputDevices(isTauri);
  const { data: style } = useWritingStyle();

  const server = health.isSuccess ? 'online' : health.isError ? 'offline' : 'connecting';
  const micName =
    devices.find((d) => d.deviceId === settings?.input_device_id)?.label ?? 'system default';
  const examples = style?.example_count ?? 0;

  return (
    <footer className="h-[30px] shrink-0 flex items-center gap-[18px] px-3.5 border-t border-border bg-sidebar font-mono text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            'h-[7px] w-[7px] rounded-full',
            server === 'online' && 'bg-success',
            server === 'offline' && 'bg-destructive',
            server === 'connecting' && 'bg-accent animate-pulse',
          )}
        />
        server {server}
      </span>
      {readiness.stt && (
        <ModelStatus name={readiness.stt.display_name} ready={readiness.stt.ready} />
      )}
      {readiness.autoRefine && readiness.llm && (
        <ModelStatus name={readiness.llm.display_name} ready={readiness.llm.ready} />
      )}
      {isTauri && <span className="truncate">mic: {micName}</span>}
      {isTauri && (
        <>
          <Permission label="accessibility" granted={readiness.accessibility} />
          <Permission label="input monitoring" granted={readiness.inputMonitoring} />
        </>
      )}
      <span className="flex-1" />
      {examples > 0 && (
        <span>
          {examples} {examples === 1 ? 'example' : 'examples'} learned
        </span>
      )}
    </footer>
  );
}

function ModelStatus({ name, ready }: { name: string; ready: boolean }) {
  return (
    <span className="whitespace-nowrap">
      {name.toLowerCase()}{' '}
      <span className={ready ? 'text-success' : 'text-warning'}>{ready ? 'ready' : 'missing'}</span>
    </span>
  );
}

function Permission({ label, granted }: { label: string; granted: boolean }): ReactNode {
  return (
    <span className="whitespace-nowrap">
      {label}{' '}
      <span className={granted ? 'text-success' : 'text-destructive'}>{granted ? '✓' : '✗'}</span>
    </span>
  );
}
