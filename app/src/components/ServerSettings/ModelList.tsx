import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelStatus } from '@/lib/api/types';
import { cn } from '@/lib/utils/cn';
import { formatSizeMb, type ModelGroup } from './modelCatalog';
import { downloadPercent, type ModelDownloadState } from './useModelDownloads';

interface ModelListProps {
  groups: ModelGroup[];
  selectedName: string | undefined;
  onSelect: (modelName: string) => void;
  stateOf: (model: ModelStatus) => ModelDownloadState;
  onDownload: (modelName: string) => void;
}

/** The models, grouped by family under small monospace headings. */
export function ModelList({ groups, selectedName, onSelect, stateOf, onDownload }: ModelListProps) {
  const { t } = useTranslation();
  return (
    <div className="pb-2">
      {groups.map((group) => (
        <section key={group.family} aria-labelledby={`model-group-${group.family}`}>
          <h2
            id={`model-group-${group.family}`}
            className="px-4 pt-3.5 pb-1.5 font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            {t(`models.groups.${group.family}`, { defaultValue: group.family })}
          </h2>
          <ul>
            {group.models.map((model) => (
              <ModelRow
                key={model.model_name}
                model={model}
                state={stateOf(model)}
                selected={model.model_name === selectedName}
                onSelect={() => onSelect(model.model_name)}
                onDownload={() => onDownload(model.model_name)}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ModelRow({
  model,
  state,
  selected,
  onSelect,
  onDownload,
}: {
  model: ModelStatus;
  state: ModelDownloadState;
  selected: boolean;
  onSelect: () => void;
  onDownload: () => void;
}) {
  const { t } = useTranslation();
  const percent = state.isDownloading ? downloadPercent(state.progress) : null;
  const size = model.downloaded && model.size_mb ? formatSizeMb(model.size_mb) : null;

  // The status on the right. "get" and "retry" start a download directly.
  let status: ReactNode;
  if (state.hasError) {
    status = (
      <RowAction className="text-destructive" onClick={onDownload} label={model.display_name}>
        {t('models.row.retry')}
      </RowAction>
    );
  } else if (state.isDownloading) {
    status = (
      <span className="text-accent">
        {percent === null ? t('models.row.connecting') : `${percent.toFixed(0)}%`}
      </span>
    );
  } else if (model.loaded) {
    status = <span className="text-accent">{t('models.row.loaded')}</span>;
  } else if (model.downloaded) {
    status = <span className="text-success">{t('models.row.downloaded')}</span>;
  } else {
    status = (
      <RowAction
        className="text-muted-foreground hover:text-foreground"
        onClick={onDownload}
        label={model.display_name}
      >
        {t('models.row.get')}
      </RowAction>
    );
  }

  return (
    <li
      className={cn(
        'flex items-center transition-colors',
        selected ? 'bg-muted shadow-[inset_2px_0_0_var(--color-accent)]' : 'hover:bg-muted/50',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 items-center gap-3 py-[11px] pl-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <StatusDot model={model} state={state} />
        <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[13.5px] text-foreground">{model.display_name}</span>
            {size && <span className="font-mono text-[11px] text-muted-foreground">{size}</span>}
          </span>
          {state.isDownloading && (
            <span className="block h-[3px] overflow-hidden rounded-sm bg-border">
              <span
                className={cn(
                  'block h-full rounded-sm bg-accent transition-[width]',
                  percent === null && 'w-1/4 animate-pulse',
                )}
                style={percent === null ? undefined : { width: `${percent}%` }}
              />
            </span>
          )}
        </span>
      </button>
      <span className="shrink-0 pr-4 pl-3 font-mono text-[11px]">{status}</span>
    </li>
  );
}

function StatusDot({ model, state }: { model: ModelStatus; state: ModelDownloadState }) {
  const tone = state.hasError
    ? 'bg-destructive'
    : state.isDownloading || model.loaded
      ? 'bg-accent'
      : model.downloaded
        ? 'bg-success'
        : 'border border-input';
  return <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', tone)} />;
}

function RowAction({
  className,
  onClick,
  label,
  children,
}: {
  className: string;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t('models.row.downloadAria', { name: label })}
      className={cn(
        'rounded px-1 -mx-1 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {children}
    </button>
  );
}
