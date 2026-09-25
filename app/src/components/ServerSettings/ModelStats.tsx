import { useQuery } from '@tanstack/react-query';
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

  // Every model shows the same cards, filled in as the model card loads, so
  // switching models or loading doesn't change the pane's height.
  const pending = isLoading;
  const stats: { key: string; label: string; value: string | null }[] = [
    {
      key: 'disk',
      label: t('models.stats.onDisk'),
      value: model.downloaded && model.size_mb ? formatSizeMb(model.size_mb) : null,
    },
    {
      key: 'license',
      label: t('models.detail.license'),
      value: license ? formatLicense(license) : null,
    },
    {
      key: 'languages',
      label: t('models.stats.languages'),
      value:
        languages.length === 0
          ? null
          : languages.length > 4
            ? t('models.stats.languagesCount', { count: languages.length })
            : languages.join(', '),
    },
    {
      key: 'downloads',
      label: t('models.detail.downloads'),
      value: info ? formatCount(info.downloads) : null,
    },
    { key: 'likes', label: t('models.detail.likes'), value: info ? formatCount(info.likes) : null },
    {
      key: 'task',
      label: t('models.stats.task'),
      value: info?.pipeline_tag ? formatPipelineTag(info.pipeline_tag) : null,
    },
    { key: 'library', label: t('models.stats.library'), value: info?.library_name ?? null },
    { key: 'author', label: t('models.stats.author'), value: info?.author ?? null },
  ];

  return (
    <dl className="grid grid-cols-3 gap-3" aria-busy={pending}>
      {stats.map((stat) => (
        <div
          key={stat.key}
          className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-card p-3.5"
        >
          <dt className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            {stat.label}
          </dt>
          {stat.value ? (
            <dd className="truncate text-[15px] leading-[22px]" title={stat.value}>
              {stat.value}
            </dd>
          ) : pending && stat.key !== 'disk' ? (
            <dd className="flex h-[22px] items-center">
              <span className="sr-only">{t('models.detail.loadingInfo')}</span>
              <span aria-hidden className="h-3 w-16 animate-pulse rounded bg-muted" />
            </dd>
          ) : (
            <dd className="text-[15px] leading-[22px] text-muted-foreground">—</dd>
          )}
        </div>
      ))}
    </dl>
  );
}
