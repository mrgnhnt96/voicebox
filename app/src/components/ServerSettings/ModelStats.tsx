import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { HuggingFaceModelInfo, ModelStatus } from '@/lib/api/types';
import { formatCount, formatLicense, formatPipelineTag, formatSizeMb } from './modelCatalog';

async function fetchHuggingFaceModelInfo(repoId: string): Promise<HuggingFaceModelInfo> {
  const response = await fetch(`https://huggingface.co/api/models/${repoId}`);
  if (!response.ok) throw new Error(`Failed to fetch model info: ${response.status}`);
  return response.json();
}

/**
 * Stat cards for a model: its size on disk from the server, plus whatever
 * its Hugging Face model card reports (license, languages, downloads…).
 */
export function ModelStats({ model }: { model: ModelStatus }) {
  const { t } = useTranslation();
  const repoId = model.hf_repo_id;

  const { data: info, isLoading } = useQuery({
    queryKey: ['hfModelInfo', repoId],
    queryFn: () => fetchHuggingFaceModelInfo(repoId!),
    enabled: !!repoId,
    staleTime: 1000 * 60 * 30, // Cache for 30 minutes
    retry: 1,
  });

  const license =
    info?.cardData?.license ||
    info?.tags?.find((tag) => tag.startsWith('license:'))?.replace('license:', '');
  const languages = info?.cardData?.language ?? [];

  const stats: { key: string; label: string; value: string }[] = [];
  if (model.downloaded && model.size_mb) {
    stats.push({
      key: 'disk',
      label: t('models.stats.onDisk'),
      value: formatSizeMb(model.size_mb),
    });
  }
  if (license) {
    stats.push({
      key: 'license',
      label: t('models.detail.license'),
      value: formatLicense(license),
    });
  }
  if (languages.length > 0) {
    stats.push({
      key: 'languages',
      label: t('models.stats.languages'),
      value:
        languages.length > 4
          ? t('models.stats.languagesCount', { count: languages.length })
          : languages.join(', '),
    });
  }
  if (info) {
    stats.push(
      { key: 'downloads', label: t('models.detail.downloads'), value: formatCount(info.downloads) },
      { key: 'likes', label: t('models.detail.likes'), value: formatCount(info.likes) },
    );
  }
  if (info?.pipeline_tag) {
    stats.push({
      key: 'task',
      label: t('models.stats.task'),
      value: formatPipelineTag(info.pipeline_tag),
    });
  }
  if (info?.library_name) {
    stats.push({ key: 'library', label: t('models.stats.library'), value: info.library_name });
  }
  if (info?.author) {
    stats.push({ key: 'author', label: t('models.stats.author'), value: info.author });
  }

  return (
    <div className="space-y-3">
      {stats.length > 0 && (
        <dl className="grid grid-cols-3 gap-3">
          {stats.map((stat) => (
            <div
              key={stat.key}
              className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-card p-3.5"
            >
              <dt className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                {stat.label}
              </dt>
              <dd className="truncate text-[15px]" title={stat.value}>
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {isLoading && (
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('models.detail.loadingInfo')}
        </div>
      )}
    </div>
  );
}
