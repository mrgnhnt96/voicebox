import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { cn } from '@/lib/utils/cn';
import { type LogEntry, useLogStore } from '@/stores/logStore';

type LogLevel = 'error' | 'warn' | 'info';
type LogFilter = 'all' | 'errors';

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * The server writes most of its logging to stderr, so the stream alone says
 * nothing about severity. Read the level from the line itself instead.
 */
function levelOf(line: string): LogLevel {
  if (/\b(ERROR|CRITICAL|FATAL|Traceback)\b|\w+(Error|Exception):/.test(line)) return 'error';
  if (/\bWARN(ING)?\b/.test(line)) return 'warn';
  return 'info';
}

function LogLine({ entry, level }: { entry: LogEntry; level: LogLevel }) {
  return (
    <div
      className={cn(
        'flex gap-3.5 px-5 font-mono text-xs leading-[1.75]',
        level === 'error' && 'bg-destructive/[0.07] text-destructive',
        level === 'warn' && 'text-warning',
        level === 'info' && 'text-foreground/80',
      )}
    >
      <span className="shrink-0 select-none text-muted-foreground/60">
        {formatTime(entry.timestamp)}
      </span>
      <span className="whitespace-pre-wrap break-all">{entry.line}</span>
    </div>
  );
}

export function LogsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const entries = useLogStore((s) => s.entries);
  const clear = useLogStore((s) => s.clear);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState<LogFilter>('all');

  const lines = useMemo(() => {
    const leveled = entries.map((entry) => ({ entry, level: levelOf(entry.line) }));
    return filter === 'errors' ? leveled.filter((l) => l.level === 'error') : leveled;
  }, [entries, filter]);

  // Auto-scroll to bottom when new entries arrive
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new line is the trigger
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines.length, autoScroll]);

  // Detect manual scroll to disable auto-scroll
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  const jumpToLatest = () => {
    setAutoScroll(true);
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight });
  };

  const copyAll = async () => {
    const text = lines
      .map(({ entry }) => `${formatTime(entry.timestamp)} ${entry.line}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: t('settings.logs.copied') });
    } catch (error) {
      toast({
        title: t('settings.logs.copyFailed'),
        description: String(error),
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4 text-xs">
        <span className="font-mono text-muted-foreground">
          {t('settings.logs.lineCount', { count: entries.length })}
        </span>
        <span className="w-3" />
        <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>
          {t('settings.logs.filterAll')}
        </FilterButton>
        <FilterButton active={filter === 'errors'} onClick={() => setFilter('errors')}>
          {t('settings.logs.filterErrors')}
        </FilterButton>
        <span className="flex-1" />
        <Button
          variant="outline"
          className="h-7 px-2.5 text-xs"
          disabled={lines.length === 0}
          onClick={copyAll}
        >
          {t('settings.logs.copyAll')}
        </Button>
        <Button
          variant="outline"
          className="h-7 px-2.5 text-xs"
          disabled={autoScroll}
          onClick={jumpToLatest}
        >
          {t('settings.logs.jumpToLatest')}
        </Button>
        <Button
          variant="ghost"
          className="h-7 px-2.5 text-xs text-destructive hover:text-destructive"
          disabled={entries.length === 0}
          onClick={clear}
        >
          {t('settings.logs.clear')}
        </Button>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        role="log"
        aria-label={t('settings.logs.title')}
        className="min-h-0 flex-1 overflow-y-auto bg-sidebar py-3"
      >
        {lines.length === 0 ? (
          <div className="space-y-1 px-5 font-mono text-xs text-muted-foreground">
            <p>
              {filter === 'errors' && entries.length > 0
                ? t('settings.logs.noErrors')
                : t('settings.logs.empty')}
            </p>
            {entries.length === 0 && !import.meta.env?.PROD && <p>{t('settings.logs.devHint')}</p>}
          </div>
        ) : (
          lines.map(({ entry, level }) => <LogLine key={entry.id} entry={entry} level={level} />)
        )}
      </div>
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'h-7 rounded-md border px-2.5 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-input bg-secondary text-foreground'
          : 'border-border bg-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
