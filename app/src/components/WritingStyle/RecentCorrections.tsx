import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PersonalExample } from '@/lib/api/types';
import { usePersonalExamples, useRemovePersonalExample } from './PersonalExamples';

/** How many corrections the settings page lists; the rest are under Your examples. */
const RECENT_LIMIT = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

function newestFirst(a: PersonalExample, b: PersonalExample): number {
  return (b.created_at ?? '').localeCompare(a.created_at ?? '');
}

/**
 * The latest examples that came from correcting a capture, said → meant, each
 * removable so Voicebox stops learning from it.
 */
export function RecentCorrections() {
  const { t } = useTranslation();
  const examples = usePersonalExamples();
  const remove = useRemovePersonalExample();
  const corrections = (examples.data ?? [])
    .filter((example) => example.source === 'correction')
    .sort(newestFirst)
    .slice(0, RECENT_LIMIT);

  const when = (createdAt: string | null) => {
    if (!createdAt) return null;
    const date = new Date(createdAt);
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    if (date.getTime() >= startOfToday) return t('writingStyle.settings.recent.today');
    if (date.getTime() >= startOfToday - DAY_MS) return t('writingStyle.settings.recent.yesterday');
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <section className="mb-7">
      <h2 className="mb-2 font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t('writingStyle.settings.recent.title')}
      </h2>
      {corrections.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('writingStyle.settings.recent.empty')}</p>
      ) : (
        <ul className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border">
          {corrections.map((example) => (
            <li
              key={example.id}
              className="flex items-center gap-3 px-3.5 py-2.5 font-mono text-xs"
            >
              <span className="min-w-0 truncate text-destructive line-through" title={example.said}>
                {example.said}
              </span>
              <span aria-hidden="true" className="shrink-0 text-muted-foreground">
                →
              </span>
              <span className="min-w-0 truncate text-success" title={example.meant}>
                {example.meant}
              </span>
              <span className="flex-1" />
              <span className="shrink-0 text-muted-foreground">{when(example.created_at)}</span>
              <button
                type="button"
                aria-label={t('writingStyle.settings.recent.remove')}
                disabled={remove.isPending}
                onClick={() => remove.mutate(example.id)}
                className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
