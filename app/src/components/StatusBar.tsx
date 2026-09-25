import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HealthResponse } from '@/lib/api/types';
import { useDictationReadiness } from '@/lib/hooks/useDictationReadiness';
import { useNativeInputDevices } from '@/lib/hooks/useNativeInputDevices';
import { useServerHealth } from '@/lib/hooks/useServer';
import { useCaptureSettings } from '@/lib/hooks/useSettings';
import { useWritingStyle } from '@/lib/hooks/useWritingStyle';
import { cn } from '@/lib/utils/cn';
import { serverStats } from '@/lib/utils/serverStats';
import { usePlatform } from '@/platform/PlatformContext';

/**
 * The always-on status line at the bottom of the window: server, models,
 * microphone, permissions and what Voicebox has learned. Each item opens
 * where it is configured, and says more on hover.
 */
export function StatusBar() {
  const platform = usePlatform();
  const navigate = useNavigate();
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
  const openModel = (model: string) => navigate({ to: '/models', search: { model } });

  return (
    <footer className="h-[30px] shrink-0 flex items-center gap-2.5 px-2 border-t border-border bg-sidebar font-mono text-[11px] text-muted-foreground">
      <StatusItem
        title={health.data ? serverDetails(health.data) : `Server ${server}`}
        onClick={() => navigate({ to: '/settings' })}
      >
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
      </StatusItem>
      {readiness.stt && (
        <ModelStatus
          use="Transcription"
          name={readiness.stt.display_name}
          ready={readiness.stt.ready}
          onClick={() => openModel(readiness.stt!.model_name)}
        />
      )}
      {readiness.autoRefine && readiness.llm && (
        <ModelStatus
          use="Refinement"
          name={readiness.llm.display_name}
          ready={readiness.llm.ready}
          onClick={() => openModel(readiness.llm!.model_name)}
        />
      )}
      {isTauri && (
        <StatusItem
          title={`Microphone: ${micName}. Click to choose another.`}
          onClick={() => navigate({ to: '/settings/dictation' })}
          className="min-w-0"
        >
          <span className="truncate">mic: {micName}</span>
        </StatusItem>
      )}
      {isTauri && (
        <>
          <Permission
            label="accessibility"
            granted={readiness.accessibility}
            purpose="Lets Voicebox type the text into the app you're using."
            onClick={readiness.openAccessibilitySettings}
          />
          <Permission
            label="input monitoring"
            granted={readiness.inputMonitoring}
            purpose="Lets Voicebox hear the dictation shortcut in any app."
            onClick={readiness.openInputMonitoringSettings}
          />
        </>
      )}
      <span className="flex-1" />
      {examples > 0 && (
        <StatusItem
          title="Examples from your corrections that cleanup learns from."
          onClick={() => navigate({ to: '/settings/writing-style' })}
        >
          {examples} {examples === 1 ? 'example' : 'examples'} learned
        </StatusItem>
      )}
    </footer>
  );
}

function StatusItem({
  title,
  onClick,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'flex h-[22px] items-center whitespace-nowrap rounded px-1.5 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className,
      )}
    >
      {children}
    </button>
  );
}

function ModelStatus({
  use,
  name,
  ready,
  onClick,
}: {
  /** What dictation uses the model for. */
  use: string;
  name: string;
  ready: boolean;
  onClick: () => void;
}) {
  return (
    <StatusItem
      title={`${use}: ${name}, ${ready ? 'downloaded and ready' : 'not downloaded'}. Click to see it in Models.`}
      onClick={onClick}
    >
      {name.toLowerCase()}{' '}
      <span className={cn('ml-1', ready ? 'text-success' : 'text-warning')}>
        {ready ? 'ready' : 'missing'}
      </span>
    </StatusItem>
  );
}

function Permission({
  label,
  granted,
  purpose,
  onClick,
}: {
  label: string;
  granted: boolean;
  purpose: string;
  onClick: () => void;
}) {
  return (
    <StatusItem
      title={`${purpose} ${granted ? 'Granted.' : 'Not granted.'} Click to open it in System Settings.`}
      onClick={onClick}
    >
      {label}{' '}
      <span className={cn('ml-1', granted ? 'text-success' : 'text-destructive')}>
        {granted ? '✓' : '✗'}
      </span>
    </StatusItem>
  );
}

/** "Running for: 2h 14m" and the rest of what the server is, for the hover tip. */
function serverDetails(health: HealthResponse): string {
  return [
    ...serverStats(health).map((stat) => `${stat.label}: ${stat.value}`),
    'Click for server settings.',
  ].join('\n');
}
