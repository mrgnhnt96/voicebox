import { useTranslation } from 'react-i18next';
import type { WritingStyleHabit } from '@/lib/api/types';
import { cn } from '@/lib/utils/cn';

/** Learned punctuation habits, one plain-language line each. */
export function WritingStyleHabits({ habits }: { habits: WritingStyleHabit[] }) {
  const { t } = useTranslation();
  return (
    <ul className="list-disc pl-5 space-y-0.5">
      {habits.map((habit) => (
        <li key={habit}>{t(`writingStyle.habits.${habit}`)}</li>
      ))}
    </ul>
  );
}

/** Learned habits as short chips, for the writing-style card. */
export function WritingStyleHabitChips({
  habits,
  className,
}: {
  habits: WritingStyleHabit[];
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <ul className={cn('flex flex-wrap gap-1.5', className)}>
      {habits.map((habit) => (
        <li
          key={habit}
          title={t(`writingStyle.habits.${habit}`)}
          className="rounded-full border border-accent/20 px-2.5 py-1 text-xs text-foreground/85"
        >
          {t(`writingStyle.habitChips.${habit}`)}
        </li>
      ))}
    </ul>
  );
}
