import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@/lib/api/client';
import { useCaptureSettings } from '@/lib/hooks/useSettings';
import { usePlatform } from '@/platform/PlatformContext';
import { ModelDetailPane } from './ModelDetailPane';
import { ModelList } from './ModelList';
import { ModelProblems } from './ModelProblems';
import { ModelStorage } from './ModelStorage';
import { groupModels, modelFamily, modelsInUse } from './modelCatalog';
import { useModelDownloads } from './useModelDownloads';

/**
 * The Models screen: a 440px list of models on the left (storage folder,
 * grouped models, problems) and the selected model's details on the right.
 */
export function ModelManagement() {
  const { t } = useTranslation();
  const platform = usePlatform();
  const { settings } = useCaptureSettings();
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const { data: modelStatus, isLoading } = useQuery({
    queryKey: ['modelStatus'],
    queryFn: () => apiClient.getModelStatus(),
    refetchInterval: 5000,
  });

  const { data: cacheDir } = useQuery({
    queryKey: ['modelsCacheDir'],
    queryFn: () => apiClient.getModelsCacheDir(),
    staleTime: 1000 * 60 * 5,
  });

  const models = modelStatus?.models ?? [];
  const downloads = useModelDownloads(modelStatus?.models);
  const groups = groupModels(models);
  const inUse = modelsInUse(settings);

  // Until the user picks one, show the transcription model dictation uses.
  const selected =
    models.find((m) => m.model_name === selectedName) ??
    models.find((m) => inUse.get(m.model_name) === 'transcription') ??
    models[0];
  const siblings = selected
    ? (groups.find((g) => g.family === modelFamily(selected.model_name))?.models ?? [])
    : [];

  return (
    <div className="flex h-full min-h-0">
      <section className="flex w-[440px] shrink-0 flex-col border-r border-border">
        <div className="flex flex-col gap-2.5 border-b border-border px-4 pt-[18px] pb-3.5">
          <h1 className="text-lg font-semibold">{t('models.title')}</h1>
          {platform.metadata.isTauri && cacheDir && <ModelStorage cacheDir={cacheDir.path} />}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ModelList
              groups={groups}
              selectedName={selected?.model_name}
              onSelect={setSelectedName}
              stateOf={downloads.stateOf}
              onDownload={downloads.download}
            />
          )}
        </div>

        <ModelProblems
          errors={downloads.erroredDownloads}
          onClearAll={downloads.clearAll}
          clearing={downloads.isClearingAll}
        />
      </section>

      {selected ? (
        <ModelDetailPane
          key={selected.model_name}
          model={selected}
          state={downloads.stateOf(selected)}
          role={inUse.get(selected.model_name)}
          siblings={siblings}
          stateOf={downloads.stateOf}
          onSelect={setSelectedName}
          cacheDir={platform.metadata.isTauri ? cacheDir?.path : undefined}
          onDownload={() => downloads.download(selected.model_name)}
          onCancel={() => downloads.cancel(selected.model_name)}
          cancelling={downloads.isCancelling(selected.model_name)}
        />
      ) : (
        !isLoading && (
          <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
            {t('models.empty')}
          </div>
        )
      )}
    </div>
  );
}
