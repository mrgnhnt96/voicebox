import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import type { ModelStatus } from '@/lib/api/types';
import { cn } from '@/lib/utils/cn';
import { ModelActions } from './ModelActions';
import { ModelStats } from './ModelStats';
import {
  formatBytes,
  formatSizeMb,
  MODEL_DESCRIPTIONS,
  type ModelRole,
  modelFamily,
} from './modelCatalog';
import { downloadPercent, type ModelDownloadState } from './useModelDownloads';

interface ModelDetailPaneProps {
  model: ModelStatus;
  state: ModelDownloadState;
  /** The role dictation uses this model for, if it's the configured one. */
  role: ModelRole | undefined;
  /** Every model in the same family, this one included. */
  siblings: ModelStatus[];
  stateOf: (model: ModelStatus) => ModelDownloadState;
  onSelect: (modelName: string) => void;
  cacheDir: string | undefined;
  onDownload: () => void;
  onCancel: () => void;
  cancelling: boolean;
}

/** Everything about the selected model, with its actions along the bottom. */
export function ModelDetailPane({
  model,
  state,
  role,
  siblings,
  stateOf,
  onSelect,
  cacheDir,
  onDownload,
  onCancel,
  cancelling,
}: ModelDetailPaneProps) {
  const { t } = useTranslation();
  const description = MODEL_DESCRIPTIONS[model.model_name];

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-col gap-2.5 border-b border-border px-8 pt-7 pb-[22px]">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-2xl font-semibold">{model.display_name}</h2>
          {model.loaded && <Badge>{t('models.status.loaded')}</Badge>}
          {role && (
            <Badge variant="secondary">
              {t('models.tags.inUse', { role: t(`models.roles.${role}`) })}
            </Badge>
          )}
          {state.hasError && <Badge variant="destructive">{t('common.error')}</Badge>}
        </div>
        <p className="text-[13px] text-muted-foreground">
          {t(`models.purpose.${modelFamily(model.model_name)}`, { defaultValue: '' })}{' '}
          {model.hf_repo_id && (
            <a
              href={`https://huggingface.co/${model.hf_repo_id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('models.detail.hfLink', { repo: model.hf_repo_id })}
            </a>
          )}
        </p>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-8 py-6">
        {description && (
          <p className="max-w-prose text-[13px] leading-relaxed text-foreground/85">
            {description}
          </p>
        )}

        {state.isDownloading && <DownloadProgress state={state} />}

        {state.error?.error && (
          <div className="whitespace-pre-wrap break-all rounded-lg border border-destructive/30 bg-destructive/[0.06] p-3 font-mono text-[11px] text-destructive">
            {state.error.error}
          </div>
        )}

        <ModelStats model={model} />

        {siblings.length > 1 && (
          <SizeComparison
            current={model.model_name}
            siblings={siblings}
            stateOf={stateOf}
            onSelect={onSelect}
          />
        )}
      </div>

      <ModelActions
        model={model}
        state={state}
        cacheDir={cacheDir}
        onDownload={onDownload}
        onCancel={onCancel}
        cancelling={cancelling}
      />
    </div>
  );
}

function DownloadProgress({ state }: { state: ModelDownloadState }) {
  const { t } = useTranslation();
  const dl = state.progress;
  const percent = downloadPercent(dl);
  return (
    <div className="space-y-2">
      <div className="h-1 overflow-hidden rounded-sm bg-border">
        <div
          className={cn(
            'h-full rounded-sm bg-accent transition-[width]',
            percent === null && 'w-1/4 animate-pulse',
          )}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <div className="font-mono text-[11px] text-muted-foreground">
        {percent !== null && dl?.total
          ? `${formatBytes(dl.current ?? 0)} / ${formatBytes(dl.total)} (${percent.toFixed(1)}%)`
          : dl?.filename || t('models.progress.connectingHf')}
      </div>
    </div>
  );
}

/** The other sizes in this model's family, with what's on disk for each. */
function SizeComparison({
  current,
  siblings,
  stateOf,
  onSelect,
}: {
  current: string;
  siblings: ModelStatus[];
  stateOf: (model: ModelStatus) => ModelDownloadState;
  onSelect: (modelName: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2.5">
      <h3 className="font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t('models.detail.compare')}
      </h3>
      <div className="grid grid-cols-3 gap-3">
        {siblings.map((sibling) => {
          const isCurrent = sibling.model_name === current;
          const sibState = stateOf(sibling);
          const detail =
            sibling.downloaded && sibling.size_mb
              ? formatSizeMb(sibling.size_mb)
              : sibState.isDownloading
                ? t('models.compare.downloading')
                : t('models.compare.notDownloaded');
          return (
            <button
              key={sibling.model_name}
              type="button"
              onClick={() => onSelect(sibling.model_name)}
              aria-current={isCurrent ? 'true' : undefined}
              className={cn(
                'flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isCurrent
                  ? 'border-accent text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground',
              )}
            >
              <span className="truncate text-[13px]">{sibling.display_name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{detail}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
