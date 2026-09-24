import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useDictationReadiness } from '@/lib/hooks/useDictationReadiness';
import { useCaptureSettings } from '@/lib/hooks/useSettings';
import { ModelsStep } from './ModelsStep';
import { PermissionStep } from './PermissionStep';
import { SetupStepRow, type StepState } from './SetupStepRow';
import { ShortcutStep } from './ShortcutStep';
import { TryItStep } from './TryItStep';
import { useModelDownloads } from './useModelDownloads';

const STEPS = ['models', 'inputMonitoring', 'accessibility', 'shortcut'] as const;
type StepId = (typeof STEPS)[number];
/** Index of the "Try it" screen that follows the four steps. */
const TRY_IT = STEPS.length;

/** The Next button names where it goes. */
const NEXT_LABEL_KEYS = [
  null,
  'setup.next.permissions',
  'setup.next.accessibility',
  'setup.next.shortcut',
  'setup.next.tryIt',
] as const;

/**
 * First-run setup: models, permissions, shortcut, try it.
 *
 * Every step reads live state, so a step the user already satisfied shows
 * as done, and one satisfied while it's open (a download landing, or a
 * permission granted in System Settings) moves the flow on by itself.
 * Nothing here blocks leaving: the rail keeps working throughout.
 */
export function SetupFlow() {
  const { t } = useTranslation();
  const readiness = useDictationReadiness();
  const downloads = useModelDownloads(readiness);
  const { settings } = useCaptureSettings();

  const done: Record<StepId, boolean> = {
    models: !!readiness.stt && !readiness.missing.some((g) => g === 'stt' || g === 'llm'),
    inputMonitoring: readiness.inputMonitoring,
    accessibility: readiness.accessibility,
    shortcut: settings?.hotkey_enabled ?? false,
  };
  const doneCount = STEPS.filter((id) => done[id]).length;
  const loaded = !readiness.isLoading && !!settings;

  /** The first unfinished step after ``from``, or Try it when none is left. */
  const nextOpen = (from: number) => {
    for (let i = from + 1; i < STEPS.length; i++) if (!done[STEPS[i]]) return i;
    return TRY_IT;
  };

  const [active, setActive] = useState<number | null>(null);

  // Open on the first unfinished step once the real state has loaded.
  useEffect(() => {
    if (active === null && loaded) setActive(nextOpen(-1));
  });

  // Move on when the open step gets satisfied while the user is on it. Only
  // a change on the same step counts, so going Back to a finished step
  // stays put.
  const activeDone = active !== null && active < TRY_IT ? done[STEPS[active]] : false;
  const previous = useRef({ active, done: activeDone });
  useEffect(() => {
    const before = previous.current;
    previous.current = { active, done: activeDone };
    if (active !== null && before.active === active && !before.done && activeDone) {
      setActive(nextOpen(active));
    }
  });

  const current = active ?? 0;

  if (current === TRY_IT) {
    return (
      <SetupPage>
        <TryItStep
          doneCount={doneCount}
          total={STEPS.length}
          onBack={() => setActive(STEPS.length - 1)}
        />
      </SetupPage>
    );
  }

  const stateOf = (index: number): StepState =>
    index === current ? 'active' : done[STEPS[index]] ? 'done' : 'todo';
  const next = nextOpen(current);
  const nextLabelKey = NEXT_LABEL_KEYS[next];
  const anyDownloading = [readiness.stt, readiness.llm].some(
    (m) => m && !m.ready && downloads.downloadByModel.has(m.model_name),
  );

  return (
    <SetupPage>
      <div className="flex flex-col gap-5">
        <div className="flex items-baseline justify-between">
          <h1 className="text-[26px] font-semibold">{t('setup.title')}</h1>
          <span className="font-mono text-xs text-muted-foreground">
            {t('setup.progress', { done: doneCount, total: STEPS.length })}
          </span>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{t('setup.intro')}</p>

        <ol
          aria-label={t('setup.stepsLabel')}
          className="flex flex-col divide-y divide-border overflow-hidden rounded-[10px] border border-border"
        >
          <li>
            <SetupStepRow
              number={1}
              title={t('setup.models.title')}
              why={t('setup.models.why')}
              state={stateOf(0)}
              satisfied={done.models}
              activeStatus={anyDownloading ? t('setup.status.downloading') : undefined}
              onSelect={() => setActive(0)}
            >
              <ModelsStep readiness={readiness} downloads={downloads} />
            </SetupStepRow>
          </li>
          <li>
            <SetupStepRow
              number={2}
              title={t('setup.inputMonitoring.title')}
              why={t('setup.inputMonitoring.why')}
              state={stateOf(1)}
              satisfied={done.inputMonitoring}
              activeStatus={t('setup.status.waiting')}
              onSelect={() => setActive(1)}
            >
              <PermissionStep
                body={t('setup.inputMonitoring.body')}
                path={t('setup.inputMonitoring.path')}
                open={readiness.openInputMonitoringSettings}
                recheck={readiness.recheckInputMonitoring}
              />
            </SetupStepRow>
          </li>
          <li>
            <SetupStepRow
              number={3}
              title={t('setup.accessibility.title')}
              why={t('setup.accessibility.why')}
              state={stateOf(2)}
              satisfied={done.accessibility}
              activeStatus={t('setup.status.waiting')}
              onSelect={() => setActive(2)}
            >
              <PermissionStep
                body={t('setup.accessibility.body')}
                path={t('setup.accessibility.path')}
                open={readiness.openAccessibilitySettings}
                recheck={readiness.recheckAccessibility}
              />
            </SetupStepRow>
          </li>
          <li>
            <SetupStepRow
              number={4}
              title={t('setup.shortcut.title')}
              why={t('setup.shortcut.why')}
              state={stateOf(3)}
              satisfied={done.shortcut}
              onSelect={() => setActive(3)}
            >
              <ShortcutStep />
            </SetupStepRow>
          </li>
        </ol>

        <div className="flex justify-between">
          {current > 0 ? (
            <Button variant="outline" size="lg" onClick={() => setActive(current - 1)}>
              {t('setup.back')}
            </Button>
          ) : (
            <span />
          )}
          {nextLabelKey ? (
            <Button size="lg" onClick={() => setActive(next)}>
              {t(nextLabelKey)}
            </Button>
          ) : null}
        </div>
      </div>
    </SetupPage>
  );
}

function SetupPage({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[680px] px-6 pb-12 pt-14">{children}</div>
    </div>
  );
}
