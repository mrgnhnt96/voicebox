import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { ActiveDownloadTask } from '@/lib/api/types';

/** Failed downloads, with a button that clears every task on the server. */
export function ModelProblems({
  errors,
  onClearAll,
  clearing,
}: {
  errors: Map<string, ActiveDownloadTask>;
  onClearAll: () => void;
  clearing: boolean;
}) {
  const { t } = useTranslation();
  if (errors.size === 0) return null;

  return (
    <section
      aria-label={t('models.problems.title')}
      className="mx-4 mt-3 mb-4 flex shrink-0 flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] p-3"
    >
      <div className="flex items-center justify-between text-[13px]">
        <span className="text-destructive">
          {t('models.problems.count', { count: errors.size })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-[22px] px-2 text-[11px] text-muted-foreground"
          onClick={onClearAll}
          disabled={clearing}
        >
          {t('models.problems.clearAll')}
        </Button>
      </div>
      <ul className="max-h-40 space-y-2 overflow-y-auto font-mono text-[11px] leading-normal text-foreground/85">
        {Array.from(errors.entries()).map(([modelName, dl]) => (
          <li key={modelName}>
            <span>{modelName}: </span>
            <span className="whitespace-pre-wrap break-all">
              {dl.error || t('models.problems.noDetails')}
            </span>
            <div className="text-muted-foreground">
              {t('models.problems.startedAt', { time: new Date(dl.started_at).toLocaleString() })}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
