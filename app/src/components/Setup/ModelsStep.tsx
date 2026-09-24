import { Link } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { ActiveDownloadTask, ModelReadiness } from '@/lib/api/types';
import type { DictationReadiness } from '@/lib/hooks/useDictationReadiness';
import { type ModelDownloads, type ModelGate, progressPercent } from './useModelDownloads';

/** Step 1 body: one progress row per model the dictation path needs. */
export function ModelsStep({
  readiness,
  downloads,
}: {
  readiness: DictationReadiness;
  downloads: ModelDownloads;
}) {
  const { t } = useTranslation();
  const { downloadByModel, download, isStarting } = downloads;

  const rows: Array<{ gate: ModelGate; model: ModelReadiness; role: string }> = [];
  if (readiness.stt)
    rows.push({ gate: 'stt', model: readiness.stt, role: t('setup.models.sttRole') });
  if (readiness.autoRefine && readiness.llm)
    rows.push({ gate: 'llm', model: readiness.llm, role: t('setup.models.llmRole') });

  return (
    <>
      {rows.map(({ gate, model, role }) => (
        <ModelRow
          key={gate}
          model={model}
          role={role}
          task={downloadByModel.get(model.model_name)}
          starting={isStarting}
          onDownload={() => download(gate, model.model_name)}
        />
      ))}
      <p className="text-xs text-muted-foreground">
        {t('setup.models.parallelHint')}{' '}
        <Link to="/models" className="text-accent hover:underline">
          {t('setup.models.chooseDifferent')}
        </Link>
      </p>
    </>
  );
}

interface ModelRowProps {
  model: ModelReadiness;
  role: string;
  task: ActiveDownloadTask | undefined;
  starting: boolean;
  onDownload: () => void;
}

function ModelRow({ model, role, task, starting, onDownload }: ModelRowProps) {
  const { t } = useTranslation();
  const downloading = !model.ready && !!task;
  const pct = model.ready ? 100 : progressPercent(task);

  let status: ReactNode;
  if (model.ready) {
    status = <span className="font-mono text-xs text-success">{t('setup.models.ready')}</span>;
  } else if (downloading) {
    status = (
      <span className="font-mono text-xs text-muted-foreground">
        {pct != null ? `${pct}%` : t('setup.models.starting')}
      </span>
    );
  } else {
    status = (
      <Button size="sm" variant="outline" disabled={starting} onClick={onDownload}>
        <Download className="h-3.5 w-3.5" aria-hidden />
        {model.size
          ? t('setup.models.downloadSize', { size: model.size })
          : t('setup.models.download')}
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span>
          {model.display_name} <span className="text-muted-foreground">· {role}</span>
        </span>
        {status}
      </div>
      <div
        role="progressbar"
        aria-label={model.display_name}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? 0}
        className="h-1 rounded-sm bg-border"
      >
        {pct != null ? (
          <div
            className={model.ready ? 'h-1 rounded-sm bg-success' : 'h-1 rounded-sm bg-accent'}
            style={{ width: `${pct}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}
