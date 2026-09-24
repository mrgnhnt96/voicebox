import {
  Accessibility,
  CheckCircle2,
  Circle,
  Cpu,
  Download,
  ExternalLink,
  Keyboard,
  Loader2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { progressPercent, useModelDownloads } from '@/components/Setup/useModelDownloads';
import { Button } from '@/components/ui/button';
import type { DictationReadiness } from '@/lib/hooks/useDictationReadiness';
import { cn } from '@/lib/utils/cn';

interface RowProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  ready: boolean;
  action?: React.ReactNode;
}

function ChecklistRow({ icon, title, description, ready, action }: RowProps) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border p-3.5 transition-colors',
        ready ? 'border-accent/20 bg-accent/5' : 'border-border bg-muted/20',
      )}
    >
      <div className="mt-0.5 shrink-0">
        {ready ? (
          <CheckCircle2 className="h-5 w-5 text-accent" />
        ) : (
          <Circle className="h-5 w-5 text-muted-foreground/50" />
        )}
      </div>
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{icon}</span>
          <p className="text-sm font-medium text-foreground">{title}</p>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
        {!ready && action ? <div className="pt-1.5">{action}</div> : null}
      </div>
    </div>
  );
}

/**
 * Renders one row per dictation-readiness gate. Each unmet gate gets an
 * inline action — Download for missing models, Open Settings for missing
 * TCC permissions — so the user can resolve everything without leaving
 * Captures.
 *
 * Download-in-progress state is sourced from ``/tasks/active`` (same query
 * the Models page uses) so it survives unmount: navigating away and back
 * still shows "Downloading…" instead of resetting to "Download".
 *
 * The chord stays disarmed until every row is green; this is what stops the
 * "stuck pill" failure mode of pressing the chord with a missing model.
 *
 * ``compact`` drops the centered title/subheading block and the
 * empty-state max-width so the checklist can be embedded in a narrow
 * sidebar alongside other settings. Callers own their own heading in
 * that mode (typically an ``<h3>`` that matches the surrounding sidebar
 * section style).
 */
export function DictationReadinessChecklist({
  readiness,
  compact = false,
}: {
  readiness: DictationReadiness;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { downloadByModel, download, isStarting } = useModelDownloads(readiness);

  const sttSize =
    readiness.stt?.size_mb != null ? `${(readiness.stt.size_mb / 1000).toFixed(1)} GB` : null;
  const llmSize =
    readiness.llm?.size_mb != null ? `${(readiness.llm.size_mb / 1000).toFixed(1)} GB` : null;

  function modelDownloadButton(
    gate: 'stt' | 'llm',
    modelName: string,
    ready: boolean,
  ): React.ReactNode {
    const task = downloadByModel.get(modelName);
    const downloading = !ready && !!task;
    const pct = progressPercent(task);
    return (
      <Button
        size="sm"
        onClick={() => download(gate, modelName)}
        disabled={downloading || isStarting}
        className="gap-1.5"
      >
        {downloading ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {pct != null
              ? t('captures.readiness.downloadingPercent', { pct })
              : t('captures.readiness.downloading')}
          </>
        ) : (
          <>
            <Download className="h-3.5 w-3.5" />
            {t('captures.readiness.downloadButton')}
          </>
        )}
      </Button>
    );
  }

  return (
    <div className={cn('w-full space-y-2.5', !compact && 'max-w-md mx-auto')}>
      {!compact && (
        <div className="text-center mb-5 space-y-1">
          <h2 className="text-base font-semibold text-foreground">
            {t('captures.readiness.title')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('captures.readiness.subheading')}</p>
        </div>
      )}

      {readiness.stt && (
        <ChecklistRow
          icon={<Cpu className="h-3.5 w-3.5" />}
          title={t('captures.readiness.stt.label', { name: readiness.stt.display_name })}
          description={
            readiness.stt.ready
              ? t('captures.readiness.stt.ready')
              : sttSize
                ? t('captures.readiness.stt.missingWithSize', { size: sttSize })
                : t('captures.readiness.stt.missing')
          }
          ready={readiness.stt.ready}
          action={modelDownloadButton('stt', readiness.stt.model_name, readiness.stt.ready)}
        />
      )}

      {readiness.autoRefine && readiness.llm && (
        <ChecklistRow
          icon={<Cpu className="h-3.5 w-3.5" />}
          title={t('captures.readiness.llm.label', { name: readiness.llm.display_name })}
          description={
            readiness.llm.ready
              ? t('captures.readiness.llm.ready')
              : llmSize
                ? t('captures.readiness.llm.missingWithSize', { size: llmSize })
                : t('captures.readiness.llm.missing')
          }
          ready={readiness.llm.ready}
          action={modelDownloadButton('llm', readiness.llm.model_name, readiness.llm.ready)}
        />
      )}

      {/* Input Monitoring + Accessibility are macOS-only TCC permissions.
          The Rust stubs return true on Windows/Linux, so rendering these
          rows there would show permanent green checkmarks with copy
          that talks about macOS — noise. Hide on non-mac. */}
      {isMacOS && (
        <ChecklistRow
          icon={<Keyboard className="h-3.5 w-3.5" />}
          title={t('captures.readiness.inputMonitoring.label')}
          description={
            readiness.inputMonitoring
              ? t('captures.readiness.inputMonitoring.ready')
              : t('captures.readiness.inputMonitoring.missing')
          }
          ready={readiness.inputMonitoring}
          action={
            <Button size="sm" onClick={readiness.openInputMonitoringSettings} className="gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" />
              {t('captures.readiness.inputMonitoring.openSettings')}
            </Button>
          }
        />
      )}

      {isMacOS && (
        <ChecklistRow
          icon={<Accessibility className="h-3.5 w-3.5" />}
          title={t('captures.readiness.accessibility.label')}
          description={
            readiness.accessibility
              ? t('captures.readiness.accessibility.ready')
              : t('captures.readiness.accessibility.missing')
          }
          ready={readiness.accessibility}
          action={
            <Button size="sm" onClick={readiness.openAccessibilitySettings} className="gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" />
              {t('captures.readiness.accessibility.openSettings')}
            </Button>
          }
        />
      )}
    </div>
  );
}

const isMacOS = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
